#ifndef INSPECTORSERVER_H
#define INSPECTORSERVER_H

#include <QObject>
#include <QPointer>
#include <QJsonObject>
#include <QJsonArray>
#include <QJsonValue>
#include <QMap>
#include <QList>
#include <QSet>
#include <QByteArray>
#include <QHash>

#include <functional>

#include "tokenrule.h"

class QTcpServer;
class QTcpSocket;
class QWidget;
class QQuickItem;
class QQuickWindow;
class QQmlEngine;

class InspectorServer : public QObject
{
    Q_OBJECT

public:
    explicit InspectorServer(QObject *parent = nullptr);
    ~InspectorServer();

    void setRootWidget(QWidget *widget);
    /// Any QObject may be the root. nullptr means "every top-level window",
    /// which is what a pure-QML QGuiApplication needs (no widget to hand over).
    void setRootObject(QObject *root);
    void start(int port);
    void stop();

    /// A secret that a client must send before any other command, as
    /// {"command": "auth", "params": {"token": "..."}}. A connection that sends
    /// anything else first, or a wrong token, gets one error line and is closed.
    /// Empty (the default) means no check. Set it before start().
    /// The token goes over the local socket as it is. It keeps out programs that do not know it; it is no protection
    /// against a program that listens on the port before the app does (that program gets the token of a client).
    void setAuthToken(const QByteArray &token);
    /// Why a value cannot be used as a token (too short), or an empty string when it can.
    static QString tokenProblem(const QByteArray &token);
    /// How long a connection may wait before it sends the token. Default 5000 ms.
    void setAuthTimeoutMs(int ms);
    /// The port the server listens on, 0 when it is not started.
    int port() const;
    /// The address the server listens on ("127.0.0.1"), empty when it is not started.
    QString listenAddress() const;
    /// At most this many connections that may send commands. When one more comes, the one that was idle
    /// the longest gets a line that says why, and is closed (see onNewConnection in the .cpp file).
    static constexpr int kMaxClients = 8;
    /// With a token: at most this many connections that have not sent it yet.
    static constexpr int kMaxWaiting = 8;
    /// The shortest token that start() accepts.
    static constexpr int kMinTokenLength = InspectorToken::kMinLength;

    /// One-liner: attach to a root and start on the given port.
    /// root may be a QWidget, a QWindow, any QObject, or nullptr (see setRootObject).
    /// If port == 0, reads QML_INSPECTOR_PORT env var (default 3768).
    /// Token: when QML_INSPECTOR_TOKEN is set, its value (without spaces around it) is the token, by the same rule
    /// as in the generic plugin. A value that is set but empty or too short is not "no token": the server is then
    /// not started (port() is 0) and one warning is logged. When the variable is not set there is no token and
    /// nothing is logged about it. An app that wants another source for the token calls setAuthToken() and start().
    static InspectorServer* attach(QObject *root, int port = 0);

    /// For tests and measurements: the connections that are open now, the bytes that connections without the token
    /// have sent and that wait for their line end, and how often the tree was walked for the texts of password fields.
    int connectionCount() const { return m_clients.size(); }
    int bytesWaiting() const;
    int secretLookups() const { return m_secretLookups; }

    /// What one client has asked for. Every connection has one of its own, and the relay client has one.
    struct Session
    {
        /// Leave what password fields hold out of the replies to this client (see "Password fields" in the README
        /// of the generic plugin). Off when a connection opens: the inspector is a tool for tests, and tests read
        /// these fields. The command "hideSecrets" turns it on for its connection; nothing turns it off again.
        bool hideSecrets = false;
    };

    /// Runs one request ({"id", "command", "params"}) of the client that `session` belongs to, and returns its reply.
    /// Public for the relay client, which serves commands without a socket.
    QJsonObject handleCommand(const QJsonObject &request, Session &session);

private slots:
    void onNewConnection();
    void onReadyRead();
    void onClientDisconnected();

private:
    // Command handlers
    QJsonObject cmdGetTree(const QJsonObject &params);
    QJsonObject cmdGetProperties(const QJsonObject &params);
    QJsonObject cmdSetProperty(const QJsonObject &params);
    QJsonObject cmdCallMethod(const QJsonObject &params);
    QJsonObject cmdFindByType(const QJsonObject &params);
    QJsonObject cmdFindByProperty(const QJsonObject &params);
    QJsonObject cmdScreenshot(const QJsonObject &params);
    QJsonObject cmdClick(const QJsonObject &params);
    QJsonObject cmdSendKeys(const QJsonObject &params);
    QJsonObject cmdMouse(const QJsonObject &params);
    QJsonObject cmdGeometry(const QJsonObject &params);
    QJsonObject cmdWheel(const QJsonObject &params);
    QJsonObject cmdEvaluate(const QJsonObject &params);
    QJsonObject cmdFindAndClick(const QJsonObject &params);
    QJsonObject cmdListInteractive(const QJsonObject &params);
    QJsonObject cmdListFileDialogs(const QJsonObject &params);
    QJsonObject cmdFileDialogAction(const QJsonObject &params);

    // Tree serialization
    QJsonObject serializeObject(QObject *obj, int maxDepth, int currentDepth = 0);
    QJsonArray serializeProperties(QObject *obj);
    QJsonValue variantToJson(const QVariant &var);

    // Hidden text: with the hiding on, what a password field holds is left out of what the reading commands send
    // (see the README for what a client that may change the app can still do).
    bool hidesTextOf(QObject *obj) const;
    void collectSecrets();
    const QSet<QString> &secrets();
    bool isSecretValue(const QVariant &value);
    bool holdsSecret(const QVariant &value);
    /// Counts one hidden value for the reply of this command, and returns null: the one form of a hidden value.
    QJsonValue hiddenValue();
    QString withoutSecrets(QString text);

    // Object registry
    QString registerObject(QObject *obj);
    QObject* resolveObject(const QString &id);
    void collectObjects(QObject *root);

    // Roots and traversal
    QList<QObject*> rootObjects() const;
    QObject* defaultRoot() const;
    QQuickWindow* quickWindowFor(QObject *obj) const;
    /// Seeds for a search: the object named by params["objectId"], else every root.
    QList<QObject*> searchSeeds(const QJsonObject &params, QString *error);
    static void enqueueChildren(QObject *obj, const std::function<void(QObject*)> &enqueue);

    // Helpers
    QQmlEngine* findQmlEngine();
    QWidget* findWidgetAt(int x, int y);
    QJsonObject errorResult(const QString &msg);
    QJsonObject okResult(const QJsonObject &data = QJsonObject());
    bool isOk(const QJsonObject &obj);
    bool isError(const QJsonObject &obj);
    QJsonArray findByType(const QString &typeName, QObject *root);

    void sendResponse(QTcpSocket *socket, const QJsonObject &response);
    void refuse(QTcpSocket *socket, int id, const QString &message);
    void readFrom(QTcpSocket *socket);
    void drop(QTcpSocket *socket, const QString &reason, int id = -1);
    void dropForRoom(QTcpSocket *socket, const QString &reason);
    void forget(QTcpSocket *socket);
    int waitingCount() const;
    QTcpSocket *longestIdle(bool mayCommand) const;

    QTcpServer *m_server = nullptr;
    QList<QTcpSocket*> m_clients;
    QMap<QTcpSocket*, QByteArray> m_buffers;
    QByteArray m_authToken;
    QSet<QTcpSocket*> m_authenticated;
    int m_authTimeoutMs = 5000;
    QSet<QString> m_secrets;
    bool m_hideSecrets = false;
    bool m_secretsCollected = false;
    int m_secretLookups = 0;
    int m_hiddenCount = 0;      // values hidden in the reply of the command that runs
    bool m_plainValues = false; // variantToJson: no hiding (only to compare a value with what the client sent)
    // The order in which the connections last sent something: a larger number is more recent.
    // A counter and not a clock, so that two connections never have the same value.
    QHash<QTcpSocket*, quint64> m_lastActive;
    quint64 m_tick = 0;

    QPointer<QObject> m_root;

    QMap<QString, QPointer<QObject>> m_idToObj;
    QMap<QObject*, QString> m_objToId;
    int m_nextId = 1;
};

#endif // INSPECTORSERVER_H
