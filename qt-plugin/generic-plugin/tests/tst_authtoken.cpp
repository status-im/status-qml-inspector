// The token check of the listening server, over a real local socket.
#include <QtTest>
#include <QGuiApplication>
#include <QTcpSocket>
#include <QNetworkInterface>
#include <QJsonDocument>
#include <QJsonObject>

#include "inspectorserver.h"

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
        // A connection to another address of this machine must not reach it.
        bool reachedElsewhere = false;
        const auto addresses = QNetworkInterface::allAddresses();
        for (const QHostAddress &address : addresses) {
            if (address.isLoopback() || address.protocol() != QAbstractSocket::IPv4Protocol)
                continue;
            QTcpSocket socket;
            socket.connectToHost(address, server.port());
            reachedElsewhere = reachedElsewhere || socket.waitForConnected(500);
        }
        QVERIFY(!reachedElsewhere);
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
        server.setAuthToken("s3cret");
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
        QTest::newRow("prefix") << "s3cre";
        QTest::newRow("longer") << "s3cret1";
        QTest::newRow("other case") << "S3CRET";
    }
    void withToken_wrongTokenIsRefusedAndClosed()
    {
        QFETCH(QString, given);
        InspectorServer server;
        server.setAuthToken("s3cret");
        server.start(0);
        Client client(server.port());
        const QJsonObject reply = client.ask("auth", token(given));
        QVERIFY(reply.value("error").toString().startsWith("Authentication failed"));
        QVERIFY(!QJsonDocument(reply).toJson().contains("s3cret"));
        QVERIFY(client.closedByServer());
    }

    void withToken_rightTokenOpensThisConnectionOnly()
    {
        InspectorServer server;
        server.setAuthToken("s3cret");
        server.start(0);
        Client client(server.port());
        QCOMPARE(client.ask("auth", token("s3cret")).value("auth").toString(), QString("accepted"));
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
        server.setAuthToken("s3cret");
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
        server.setAuthToken("s3cret");
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
