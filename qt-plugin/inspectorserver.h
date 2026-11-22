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

#include <functional>

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
    void setAuthToken(const QByteArray &token);
    /// The port the server listens on, 0 when it is not started.
    int port() const;

    /// One-liner: attach to a root and start on the given port.
    /// root may be a QWidget, a QWindow, any QObject, or nullptr (see setRootObject).
    /// If port == 0, reads QML_INSPECTOR_PORT env var (default 3768).
    /// Reads the token from the QML_INSPECTOR_TOKEN env var (see setAuthToken).
    static InspectorServer* attach(QObject *root, int port = 0);

    /// Runs one request ({"id", "command", "params"}) and returns its reply.
    /// Public for the relay client, which serves commands without a socket.
    QJsonObject handleCommand(const QJsonObject &request);

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

    QTcpServer *m_server = nullptr;
    QList<QTcpSocket*> m_clients;
    QMap<QTcpSocket*, QByteArray> m_buffers;
    QByteArray m_authToken;
    QSet<QTcpSocket*> m_authenticated;

    QPointer<QObject> m_root;

    QMap<QString, QPointer<QObject>> m_idToObj;
    QMap<QObject*, QString> m_objToId;
    int m_nextId = 1;
};

#endif // INSPECTORSERVER_H
