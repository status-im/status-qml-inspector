// The token check of the listening server, over a real local socket.
#include <QtTest>
#include <QGuiApplication>
#include <QTcpSocket>
#include <QNetworkInterface>
#include <QJsonDocument>
#include <QJsonObject>
#include <memory>
#include <vector>

#include "inspectorserver.h"

// 18 characters: the server takes no token shorter than 16.
#define TOKEN "s3cret-of-16-chars"

class Client
{
public:
    explicit Client(int port, bool wait = true)
    {
        m_socket.connectToHost(QHostAddress::LocalHost, port);
        if (wait)
            m_socket.waitForConnected(2000);
    }

    // Sends one command and returns the reply line, empty when the server sent none.
    QJsonObject ask(const QString &command, const QJsonObject &params = {})
    {
        const QJsonObject request{{"id", ++m_id}, {"command", command}, {"params", params}};
        m_socket.write(QJsonDocument(request).toJson(QJsonDocument::Compact) + '\n');
        return readLine();
    }
    QJsonObject sendRaw(const QByteArray &bytes)
    {
        m_socket.write(bytes);
        return readLine();
    }
    // Writes without waiting for a reply, and without running the event loop of the server.
    void writeOnly(const QByteArray &bytes)
    {
        m_socket.write(bytes);
        m_socket.waitForBytesWritten(2000);
    }
    QJsonObject readLine()
    {
        // Whether the line came is seen by what readLine() returns.
        (void) QTest::qWaitFor([this] { return m_socket.canReadLine() || m_socket.state() == QAbstractSocket::UnconnectedState; }, 2000);
        return QJsonDocument::fromJson(m_socket.readLine()).object();
    }
    // Every line that has arrived, after the server closed the connection.
    QList<QByteArray> linesUntilClosed()
    {
        closedByServer();
        QList<QByteArray> lines;
        while (m_socket.canReadLine())
            lines.append(m_socket.readLine().trimmed());
        return lines;
    }
    bool closedByServer()
    {
        return QTest::qWaitFor([this] { return m_socket.state() == QAbstractSocket::UnconnectedState; }, 2000);
    }
    bool isOpen() const { return m_socket.state() == QAbstractSocket::ConnectedState; }
    bool waitConnected() { return m_socket.waitForConnected(2000); }

private:
    QTcpSocket m_socket;
    int m_id = 0;
};

class tst_AuthToken : public QObject
{
    Q_OBJECT

private:
    static QJsonObject token(const QString &value) { return QJsonObject{{"token", value}}; }

private slots:
    void listensOnLoopbackOnly()
    {
        InspectorServer server;
        server.start(0);
        QVERIFY(server.port() > 0);
        QCOMPARE(server.listenAddress(), QString("127.0.0.1"));
        // A connection to another address of this machine must not reach it. One address is enough:
        // the server has one listening socket.
        bool tried = false;
        const auto addresses = QNetworkInterface::allAddresses();
        for (const QHostAddress &address : addresses) {
            if (address.isLoopback() || address.protocol() != QAbstractSocket::IPv4Protocol)
                continue;
            QTcpSocket socket;
            socket.connectToHost(address, server.port());
            QVERIFY(!socket.waitForConnected(300));
            tried = true;
            break;
        }
        // A machine with the loopback address only: the test must not pass as if the other address was tried.
        if (!tried)
            QSKIP("This machine has no address besides loopback: a connection from another address was not tried.");
    }

    void tooShortToken_serverDoesNotStart()
    {
        // A short token must not turn into "no token".
        InspectorServer server;
        server.setAuthToken("short");
        server.start(0);
        QCOMPARE(server.port(), 0);
        QVERIFY(!InspectorServer::tokenProblem("short").isEmpty());
        QVERIFY(!InspectorServer::tokenProblem("").isEmpty());
        QVERIFY(InspectorServer::tokenProblem(TOKEN).isEmpty());
    }

    void withToken_silentConnectionIsClosedAfterTheTimeout()
    {
        InspectorServer server;
        server.setAuthToken(TOKEN);
        server.setAuthTimeoutMs(200);
        server.start(0);
        Client silent(server.port());
        // A connection that sent the token in time stays open after the timeout.
        Client client(server.port());
        QCOMPARE(client.ask("auth", token(TOKEN)).value("auth").toString(), QString("accepted"));
        // The silent one was opened first: when it is closed, the timeout of the other one is over too.
        QCOMPARE(silent.readLine().value("error").toString(), QString("Authentication required: no token was sent in time"));
        QVERIFY(silent.closedByServer());
        QVERIFY(QTest::qWaitFor([&] { return server.connectionCount() == 1; }, 2000));
        QVERIFY(client.ask("getTree", {{"depth", 1}}).value("ok").toBool());
    }

    // Without a token: connections that are held open cannot lock a client out. One more connection gets in,
    // and the one that was idle the longest is closed with a line that says why.
    void withoutToken_idleConnectionsCannotLockAClientOut()
    {
        InspectorServer server;
        server.start(0);
        std::vector<std::unique_ptr<Client>> idle;
        for (int i = 0; i < InspectorServer::kMaxClients; ++i) {
            idle.push_back(std::make_unique<Client>(server.port()));
            // The server has taken the connection when it answers on it.
            QVERIFY(idle.back()->ask("getTree", {{"depth", 0}}).value("ok").toBool());
        }
        // The first one is used again: it is no longer the one that was idle the longest.
        QVERIFY(idle[0]->ask("getTree", {{"depth", 1}}).value("ok").toBool());
        Client extra(server.port());
        QVERIFY(extra.ask("getTree", {{"depth", 1}}).value("ok").toBool());
        const QString reason = idle[1]->sendRaw("").value("error").toString();
        QVERIFY2(reason.startsWith("Connection closed: there are more than 8 connections"), qPrintable(reason));
        QVERIFY(idle[1]->closedByServer());
        QVERIFY(idle[0]->ask("getTree", {{"depth", 1}}).value("ok").toBool());
        QVERIFY(idle.back()->ask("getTree", {{"depth", 1}}).value("ok").toBool());
        // It goes on like that: there are never more than the limit, and the newest always gets in.
        for (int i = 0; i < 20; ++i) {
            Client more(server.port());
            QVERIFY(more.ask("getTree", {{"depth", 1}}).value("ok").toBool());
        }
    }

    // With a token: connections that never send it cannot lock out a client that has it.
    void withToken_waitingConnectionsCannotLockOutAClientWithTheToken()
    {
        InspectorServer server;
        server.setAuthToken(TOKEN);
        server.setAuthTimeoutMs(60000);
        server.start(0);
        std::vector<std::unique_ptr<Client>> silent;
        for (int i = 0; i < InspectorServer::kMaxWaiting; ++i) {
            silent.push_back(std::make_unique<Client>(server.port()));
            QVERIFY(QTest::qWaitFor([&] { return server.connectionCount() == i + 1; }, 2000));
        }
        Client client(server.port());
        QCOMPARE(client.ask("auth", token(TOKEN)).value("auth").toString(), QString("accepted"));
        QVERIFY(client.ask("getTree", {{"depth", 1}}).value("ok").toBool());
        // The one that waited the longest made room, and was told why.
        const QString reason = silent[0]->sendRaw("").value("error").toString();
        QVERIFY2(reason.startsWith("Connection closed: too many connections wait for the token check"), qPrintable(reason));
        QVERIFY(silent[0]->closedByServer());
        // Many more that never send the token: the client with the token is not touched.
        for (int i = 0; i < 30; ++i)
            silent.push_back(std::make_unique<Client>(server.port()));
        // All 30 were taken: there are never more than the limit, plus the one with the token.
        QVERIFY(QTest::qWaitFor([&] { return server.connectionCount() == InspectorServer::kMaxWaiting + 1; }, 2000));
        for (int i = 0; i < 22; ++i)
            QVERIFY(silent[size_t(i) + 1]->closedByServer());
        QVERIFY(client.ask("getTree", {{"depth", 1}}).value("ok").toBool());
        Client second(server.port());
        QCOMPARE(second.ask("auth", token(TOKEN)).value("auth").toString(), QString("accepted"));
    }

    // With a token: the places of the connections that sent it are their own. One more with the token gets in,
    // and the one that was idle the longest is closed with a line that says why.
    void withToken_oneMoreWithTheTokenTakesThePlaceOfTheIdlest()
    {
        InspectorServer server;
        server.setAuthToken(TOKEN);
        server.start(0);
        std::vector<std::unique_ptr<Client>> clients;
        for (int i = 0; i < InspectorServer::kMaxClients; ++i) {
            clients.push_back(std::make_unique<Client>(server.port()));
            QCOMPARE(clients.back()->ask("auth", token(TOKEN)).value("auth").toString(), QString("accepted"));
        }
        Client extra(server.port());
        QCOMPARE(extra.ask("auth", token(TOKEN)).value("auth").toString(), QString("accepted"));
        QVERIFY(extra.ask("getTree", {{"depth", 1}}).value("ok").toBool());
        const QString reason = clients[0]->sendRaw("").value("error").toString();
        QVERIFY2(reason.startsWith("Connection closed: there are more than 8 connections"), qPrintable(reason));
        QVERIFY(clients[0]->closedByServer());
        for (size_t i = 1; i < clients.size(); ++i)
            QVERIFY(clients[i]->ask("getTree", {{"depth", 1}}).value("ok").toBool());
    }

    void withoutToken_commandsWorkAsBefore()
    {
        InspectorServer server;
        server.start(0);
        Client client(server.port());
        QVERIFY(client.ask("getTree", {{"depth", 1}}).value("ok").toBool());
        // A client that has a token may still send it.
        QCOMPARE(client.ask("auth", token("anything")).value("auth").toString(), QString("not required"));
        QVERIFY(client.ask("getTree", {{"depth", 1}}).value("ok").toBool());
    }

    void withToken_commandBeforeAuthIsRefusedAndClosed()
    {
        InspectorServer server;
        server.setAuthToken(TOKEN);
        server.start(0);
        Client client(server.port());
        const QJsonObject reply = client.ask("evaluate", {{"expression", "1+1"}});
        QVERIFY(reply.value("error").toString().startsWith("Authentication required"));
        QVERIFY(!reply.contains("result"));
        QVERIFY(client.closedByServer());
    }

    void withToken_wrongTokenIsRefusedAndClosed_data()
    {
        QTest::addColumn<QString>("given");
        QTest::newRow("other value") << "wrong";
        QTest::newRow("empty") << "";
        QTest::newRow("prefix") << "s3cret-of-16-char";
        QTest::newRow("longer") << TOKEN "1";
        QTest::newRow("other case") << "S3CRET-OF-16-CHARS";
    }
    void withToken_wrongTokenIsRefusedAndClosed()
    {
        QFETCH(QString, given);
        InspectorServer server;
        server.setAuthToken(TOKEN);
        server.start(0);
        Client client(server.port());
        const QJsonObject reply = client.ask("auth", token(given));
        QVERIFY(reply.value("error").toString().startsWith("Authentication failed"));
        QVERIFY(!QJsonDocument(reply).toJson().contains(TOKEN));
        QVERIFY(client.closedByServer());
    }

    void withToken_rightTokenOpensThisConnectionOnly()
    {
        InspectorServer server;
        server.setAuthToken(TOKEN);
        server.start(0);
        Client client(server.port());
        QCOMPARE(client.ask("auth", token(TOKEN)).value("auth").toString(), QString("accepted"));
        QVERIFY(client.ask("getTree", {{"depth", 1}}).value("ok").toBool());

        Client other(server.port());
        QVERIFY(other.ask("getTree", {{"depth", 1}}).value("error").toString().startsWith("Authentication required"));
        QVERIFY(other.closedByServer());
        // The first connection is not affected.
        QVERIFY(client.ask("getTree", {{"depth", 1}}).value("ok").toBool());
    }

    void withToken_commandsInOnePacketAfterBadAuthAreNotRun()
    {
        InspectorServer server;
        server.setAuthToken(TOKEN);
        server.start(0);
        Client client(server.port());
        const QJsonObject first = client.sendRaw(
            "{\"id\":1,\"command\":\"auth\",\"params\":{\"token\":\"wrong\"}}\n"
            "{\"id\":2,\"command\":\"getTree\",\"params\":{}}\n");
        QVERIFY(first.value("error").toString().startsWith("Authentication failed"));
        QVERIFY(client.closedByServer());
        QVERIFY(client.sendRaw("").isEmpty());
    }

    void withToken_longLineBeforeAuthClosesTheConnection()
    {
        InspectorServer server;
        server.setAuthToken(TOKEN);
        server.start(0);
        Client client(server.port());
        const QJsonObject reply = client.sendRaw(QByteArray(8000, 'x'));
        QVERIFY(reply.value("error").toString().startsWith("Authentication required"));
        QVERIFY(client.closedByServer());
    }

    // A connection that has not sent the token is closed at its first line that is not the token, with one line that says why.
    void withToken_firstLineThatIsNotTheToken_closesTheConnection_data()
    {
        QTest::addColumn<QByteArray>("bytes");
        QTest::newRow("garbage") << QByteArray("garbage\n");
        QTest::newRow("many garbage lines") << QByteArray("a\nb\nc\nd\ne\nf\ng\nh\n");
        QTest::newRow("json that is not an object") << QByteArray("[1,2]\n");
        QTest::newRow("null") << QByteArray("null\n");
        QTest::newRow("object without a command") << QByteArray("{\"id\":1}\n{\"id\":2}\n");
        QTest::newRow("half an object") << QByteArray("{\"id\":1,\"command\":\n");
        QTest::newRow("garbage then the right token") << QByteArray("x\n{\"id\":1,\"command\":\"auth\",\"params\":{\"token\":\"" TOKEN "\"}}\n");
    }
    void withToken_firstLineThatIsNotTheToken_closesTheConnection()
    {
        QFETCH(QByteArray, bytes);
        InspectorServer server;
        server.setAuthToken(TOKEN);
        server.setAuthTimeoutMs(60000);
        server.start(0);
        Client client(server.port());
        client.writeOnly(bytes);
        const QList<QByteArray> lines = client.linesUntilClosed();
        QVERIFY(!client.isOpen());
        // One line, however many lines the client sent.
        QCOMPARE(lines.size(), 1);
        const QJsonObject reply = QJsonDocument::fromJson(lines.first()).object();
        QVERIFY2(reply.value("error").toString().startsWith("Authentication required"), lines.first().constData());
        QVERIFY(!reply.contains("auth"));
        QCOMPARE(server.connectionCount(), 0);
    }

    // Lines without content are no command: they are skipped and get no reply.
    void withToken_emptyLinesBeforeTheToken_getNoReply()
    {
        InspectorServer server;
        server.setAuthToken(TOKEN);
        server.start(0);
        Client client(server.port());
        client.writeOnly("\n\n  \n");
        QCOMPARE(client.ask("auth", token(TOKEN)).value("auth").toString(), QString("accepted"));
    }

    void withToken_tokenInTwoPackets_isAccepted()
    {
        InspectorServer server;
        server.setAuthToken(TOKEN);
        server.start(0);
        Client client(server.port());
        const QByteArray line = "{\"id\":7,\"command\":\"auth\",\"params\":{\"token\":\"" TOKEN "\"}}\n";
        client.writeOnly(line.left(30));
        // The first part has arrived and the connection still waits.
        QVERIFY(QTest::qWaitFor([&] { return server.bytesWaiting() == 30; }, 2000));
        QVERIFY(client.isOpen());
        const QJsonObject reply = client.sendRaw(line.mid(30));
        QCOMPARE(reply.value("auth").toString(), QString("accepted"));
        QCOMPARE(reply.value("id").toInt(), 7);
        QVERIFY(client.ask("getTree", {{"depth", 1}}).value("ok").toBool());
    }

    // The longest line a connection may send before the token: 4096 bytes.
    void withToken_lineBeforeTheToken_mayHave4096Bytes()
    {
        const QByteArray auth = "{\"id\":1,\"command\":\"auth\",\"params\":{\"token\":\"" TOKEN "\"}}";
        {
            // 4096 bytes and the line end: accepted.
            InspectorServer server;
            server.setAuthToken(TOKEN);
            server.start(0);
            Client client(server.port());
            const QByteArray line = auth + QByteArray(4096 - auth.size(), ' ');
            QCOMPARE(line.size(), 4096);
            QCOMPARE(client.sendRaw(line + '\n').value("auth").toString(), QString("accepted"));
        }
        {
            // 4097 bytes: refused, also when it is the right token.
            InspectorServer server;
            server.setAuthToken(TOKEN);
            server.start(0);
            Client client(server.port());
            const QJsonObject reply = client.sendRaw(auth + QByteArray(4097 - auth.size(), ' ') + '\n');
            QVERIFY(reply.value("error").toString().startsWith("Authentication required"));
            QVERIFY(client.closedByServer());
        }
        {
            // 4096 bytes without a line end: the connection waits. One more byte: closed.
            InspectorServer server;
            server.setAuthToken(TOKEN);
            server.setAuthTimeoutMs(60000);
            server.start(0);
            Client client(server.port());
            client.writeOnly(QByteArray(4096, 'x'));
            QVERIFY(QTest::qWaitFor([&] { return server.bytesWaiting() == 4096; }, 2000));
            QVERIFY(client.isOpen());
            QVERIFY(client.sendRaw("x").value("error").toString().startsWith("Authentication required"));
            QVERIFY(client.closedByServer());
        }
    }

    void withToken_wrongTokenOnAnAcceptedConnection_closesIt()
    {
        InspectorServer server;
        server.setAuthToken(TOKEN);
        server.start(0);
        Client client(server.port());
        QCOMPARE(client.ask("auth", token(TOKEN)).value("auth").toString(), QString("accepted"));
        // The right token again changes nothing.
        QCOMPARE(client.ask("auth", token(TOKEN)).value("auth").toString(), QString("accepted"));
        QVERIFY(client.ask("auth", token("wrong")).value("error").toString().startsWith("Authentication failed"));
        QVERIFY(client.closedByServer());
        QCOMPARE(server.connectionCount(), 0);
    }

    // A token that has arrived is checked before a waiting connection is closed to make room.
    // Here nine connections are taken in one go, and the first of them has sent its token already.
    void withToken_tokenThatHasArrived_isCheckedBeforeAConnectionIsDropped()
    {
        InspectorServer server;
        server.setAuthToken(TOKEN);
        server.setAuthTimeoutMs(60000);
        server.start(0);
        // No event of the server runs until all nine are connected: the waits below are on the client sockets only.
        Client first(server.port());
        first.writeOnly("{\"id\":1,\"command\":\"auth\",\"params\":{\"token\":\"" TOKEN "\"}}\n");
        std::vector<std::unique_ptr<Client>> silent;
        for (int i = 0; i < InspectorServer::kMaxWaiting; ++i)
            silent.push_back(std::make_unique<Client>(server.port()));
        QCOMPARE(server.connectionCount(), 0);
        const QJsonObject reply = first.readLine();
        QCOMPARE(reply.value("auth").toString(), QString("accepted"));
        QVERIFY(first.ask("getTree", {{"depth", 1}}).value("ok").toBool());
        // Nobody had to go: eight wait, one has the token.
        QCOMPARE(server.connectionCount(), InspectorServer::kMaxWaiting + 1);
        for (const auto &client : silent)
            QVERIFY(client->isOpen());
    }

    void stop_closesEveryConnection_andTheServerStartsAgain()
    {
        InspectorServer server;
        server.setAuthToken(TOKEN);
        server.setAuthTimeoutMs(60000);
        server.start(0);
        Client withToken(server.port());
        QCOMPARE(withToken.ask("auth", token(TOKEN)).value("auth").toString(), QString("accepted"));
        std::vector<std::unique_ptr<Client>> waiting;
        for (int i = 0; i < 5; ++i)
            waiting.push_back(std::make_unique<Client>(server.port()));
        QVERIFY(QTest::qWaitFor([&] { return server.connectionCount() == 6; }, 2000));
        server.stop();
        QCOMPARE(server.port(), 0);
        QCOMPARE(server.connectionCount(), 0);
        QVERIFY(withToken.closedByServer());
        for (const auto &client : waiting)
            QVERIFY(client->closedByServer());
        server.start(0);
        QVERIFY(server.port() > 0);
        Client again(server.port());
        QCOMPARE(again.ask("auth", token(TOKEN)).value("auth").toString(), QString("accepted"));
    }

    // attach() is for an app that builds the server in. It reads QML_INSPECTOR_TOKEN by the same rule as the plugin.
    void attach_usesTheTokenOfTheEnvironment()
    {
        QObject root;
        qputenv("QML_INSPECTOR_PORT", "0");
        {
            qunsetenv("QML_INSPECTOR_TOKEN");
            std::unique_ptr<InspectorServer> server(InspectorServer::attach(&root, 0));
            QVERIFY(server->port() > 0);
            Client client(server->port());
            QVERIFY(client.ask("getTree", {{"depth", 0}}).value("ok").toBool());
        }
        {
            qputenv("QML_INSPECTOR_TOKEN", "  " TOKEN " ");
            std::unique_ptr<InspectorServer> server(InspectorServer::attach(&root, 0));
            QVERIFY(server->port() > 0);
            Client without(server->port());
            QVERIFY(without.ask("getTree", {{"depth", 0}}).value("error").toString().startsWith("Authentication required"));
            Client with(server->port());
            QCOMPARE(with.ask("auth", token(TOKEN)).value("auth").toString(), QString("accepted"));
        }
        for (const char *unusable : {"", "   ", "short"}) {
            // Set but not usable: the server stays off. It is never taken as "no token".
            qputenv("QML_INSPECTOR_TOKEN", unusable);
            std::unique_ptr<InspectorServer> server(InspectorServer::attach(&root, 0));
            QCOMPARE(server->port(), 0);
        }
        qunsetenv("QML_INSPECTOR_TOKEN");
        qunsetenv("QML_INSPECTOR_PORT");
    }
};

int main(int argc, char **argv)
{
    qputenv("QT_QPA_PLATFORM", "offscreen");
    QGuiApplication app(argc, argv);
    tst_AuthToken test;
    return QTest::qExec(&test, argc, argv);
}

#include "tst_authtoken.moc"
