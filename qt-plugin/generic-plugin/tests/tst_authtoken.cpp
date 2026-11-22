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
    explicit Client(int port) { m_socket.connectToHost(QHostAddress::LocalHost, port); m_socket.waitForConnected(2000); }

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
    bool closedByServer()
    {
        for (int i = 0; i < 40 && m_socket.state() != QAbstractSocket::UnconnectedState; ++i)
            QTest::qWait(25);
        return m_socket.state() == QAbstractSocket::UnconnectedState;
    }

private:
    QJsonObject readLine()
    {
        for (int i = 0; i < 80 && !m_socket.canReadLine(); ++i) {
            QTest::qWait(25);
            if (m_socket.state() == QAbstractSocket::UnconnectedState && !m_socket.canReadLine())
                break;
        }
        return QJsonDocument::fromJson(m_socket.readLine()).object();
    }
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
        const auto addresses = QNetworkInterface::allAddresses();
        for (const QHostAddress &address : addresses) {
            if (address.isLoopback() || address.protocol() != QAbstractSocket::IPv4Protocol)
                continue;
            QTcpSocket socket;
            socket.connectToHost(address, server.port());
            QVERIFY(!socket.waitForConnected(300));
            break;
        }
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
        QVERIFY(silent.closedByServer());
        // A connection that sent the token in time stays open after the timeout.
        Client client(server.port());
        QCOMPARE(client.ask("auth", token(TOKEN)).value("auth").toString(), QString("accepted"));
        QTest::qWait(400);
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
            QTest::qWait(5);
        }
        QTest::qWait(50);
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
            QTest::qWait(5);
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
        QTest::qWait(100);
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
            QTest::qWait(5);
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
};

int main(int argc, char **argv)
{
    qputenv("QT_QPA_PLATFORM", "offscreen");
    QGuiApplication app(argc, argv);
    tst_AuthToken test;
    return QTest::qExec(&test, argc, argv);
}

#include "tst_authtoken.moc"
