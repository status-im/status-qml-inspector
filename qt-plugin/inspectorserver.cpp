#include "inspectorserver.h"

#include <QTcpServer>
#include <QTcpSocket>
#include <QJsonDocument>
#include <QSet>
#include <QCryptographicHash>
#include <QTimer>
#include <QHostAddress>
#include <QWidget>
#include <QWindow>
#include <QQuickItem>
// QuickWidgets support is compiled in whenever the module is linked (Qt defines
// QT_QUICKWIDGETS_LIB through the target's usage requirements); a build without the
// module, such as an Android APK that does not bundle it, may force it off with
// -DQMLINSPECTOR_HAVE_QUICKWIDGETS=0.
#ifndef QMLINSPECTOR_HAVE_QUICKWIDGETS
#  if defined(QT_QUICKWIDGETS_LIB) || __has_include(<QQuickWidget>)
#    define QMLINSPECTOR_HAVE_QUICKWIDGETS 1
#  else
#    define QMLINSPECTOR_HAVE_QUICKWIDGETS 0
#  endif
#endif
#if QMLINSPECTOR_HAVE_QUICKWIDGETS
#include <QQuickWidget>
#endif
#include <QQuickWindow>
#include <QQmlEngine>
#include <QQmlExpression>
#include <QQmlContext>
#include <QMetaObject>
#include <QMetaProperty>
#include <QMetaMethod>
#include <QBuffer>
#include <QPixmap>
#include <QImage>
#include <QMouseEvent>
#include <QWheelEvent>
#include <QKeyEvent>
#include <QKeySequence>
#include <QApplication>
#include <QGuiApplication>
#include <QDebug>
#include <QColor>
#include <QUrl>
#include <QRectF>
#include <QPointF>
#include <QSizeF>
#include <QFont>
#include <QFileDialog>
#include <QDialog>
#include <QJSValue>

InspectorServer::InspectorServer(QObject *parent)
    : QObject(parent)
{
}

InspectorServer::~InspectorServer()
{
    stop();
}

// A line longer than this from a client that has not sent the token is dropped
// with the connection, so that such a client cannot fill the memory.
static const int kMaxLineBeforeAuth = 4096;

// Compares in the same time whatever the two values are: the digests have one
// length, and every byte of them is looked at.
static bool sameToken(const QByteArray &expected, const QByteArray &given)
{
    const QByteArray a = QCryptographicHash::hash(expected, QCryptographicHash::Sha256);
    const QByteArray b = QCryptographicHash::hash(given, QCryptographicHash::Sha256);
    uchar diff = 0;
    for (int i = 0; i < a.size(); ++i)
        diff |= uchar(a.at(i)) ^ uchar(b.at(i));
    return diff == 0;
}

void InspectorServer::setAuthToken(const QByteArray &token)
{
    m_authToken = token;
}

QString InspectorServer::tokenProblem(const QByteArray &token)
{
    if (token.size() < kMinTokenLength)
        return QStringLiteral("the token must have at least %1 characters").arg(kMinTokenLength);
    return QString();
}

void InspectorServer::setAuthTimeoutMs(int ms)
{
    m_authTimeoutMs = ms;
}

QString InspectorServer::listenAddress() const
{
    return m_server ? m_server->serverAddress().toString() : QString();
}

int InspectorServer::port() const
{
    return m_server ? m_server->serverPort() : 0;
}

void InspectorServer::setRootWidget(QWidget *widget)
{
    m_root = widget;
}

void InspectorServer::setRootObject(QObject *root)
{
    m_root = root;
}

void InspectorServer::start(int port)
{
    if (m_server)
        return;

    // A token that is too short is not used as "no token": the server stays off.
    if (!m_authToken.isEmpty() && !tokenProblem(m_authToken).isEmpty()) {
        qWarning().noquote() << "[QmlInspector] Not started:" << tokenProblem(m_authToken);
        return;
    }

    m_server = new QTcpServer(this);
    connect(m_server, &QTcpServer::newConnection, this, &InspectorServer::onNewConnection);

    // Loopback only: the commands are unauthenticated, so nothing off the
    // device may reach them. Tests connect from an adb shell on the device.
    if (!m_server->listen(QHostAddress::LocalHost, port)) {
        qWarning() << "[QmlInspector] Failed to listen on port" << port
                    << ":" << m_server->errorString();
        delete m_server;
        m_server = nullptr;
        return;
    }

    qInfo() << "[QmlInspector] Inspector server listening on port"
            << m_server->serverPort();
    if (!m_authToken.isEmpty())
        qInfo("[QmlInspector] Clients must send the token first");
}

void InspectorServer::stop()
{
    if (m_server) {
        for (auto *client : m_clients)
            client->disconnectFromHost();
        m_clients.clear();
        m_buffers.clear();
        m_authenticated.clear();
        m_lastActive.clear();
        m_server->close();
        delete m_server;
        m_server = nullptr;
    }
}

InspectorServer* InspectorServer::attach(QObject *root, int port)
{
    if (port == 0) {
        bool ok;
        int envPort = qEnvironmentVariableIntValue("QML_INSPECTOR_PORT", &ok);
        port = ok ? envPort : 3768;
    }

    auto *inspector = new InspectorServer(root);
    inspector->setRootObject(root);
    inspector->start(port);
    return inspector;
}

// --- Roots and traversal ---

QList<QObject*> InspectorServer::rootObjects() const
{
    QList<QObject*> roots;
    if (m_root) {
        roots.append(m_root.data());
        return roots;
    }
    for (QWindow *w : QGuiApplication::topLevelWindows())
        roots.append(w);
    return roots;
}

QObject* InspectorServer::defaultRoot() const
{
    const QList<QObject*> roots = rootObjects();
    return roots.isEmpty() ? nullptr : roots.first();
}

QQuickWindow* InspectorServer::quickWindowFor(QObject *obj) const
{
    if (auto *win = qobject_cast<QQuickWindow*>(obj))
        return win;
    if (auto *item = qobject_cast<QQuickItem*>(obj))
        return item->window();
#if QMLINSPECTOR_HAVE_QUICKWIDGETS
    if (auto *qw = qobject_cast<QQuickWidget*>(obj))
        return qw->quickWindow();
#endif
    if (auto *focus = qobject_cast<QQuickWindow*>(QGuiApplication::focusWindow()))
        return focus;
    for (QObject *r : rootObjects())
        if (auto *win = qobject_cast<QQuickWindow*>(r))
            return win;
    return nullptr;
}

QList<QObject*> InspectorServer::searchSeeds(const QJsonObject &params, QString *error)
{
    QString objectId = params.value("objectId").toString();
    if (!objectId.isEmpty()) {
        QObject *obj = resolveObject(objectId);
        if (!obj) {
            *error = "Object not found: " + objectId;
            return {};
        }
        return {obj};
    }
    QList<QObject*> roots = rootObjects();
    if (roots.isEmpty())
        *error = "No root object";
    return roots;
}

void InspectorServer::enqueueChildren(QObject *obj, const std::function<void(QObject*)> &enqueue)
{
    if (auto *item = qobject_cast<QQuickItem*>(obj)) {
        for (auto *child : item->childItems())
            enqueue(child);
        // An open popup shows as an item in the overlay. The popup object owns that item
        // but is nobody's child item, so it is reached through the item.
        if (item->inherits("QQuickPopupItem") && item->parent() && item->parent()->inherits("QQuickPopup"))
            enqueue(item->parent());
    }
#if QMLINSPECTOR_HAVE_QUICKWIDGETS
    if (auto *qw = qobject_cast<QQuickWidget*>(obj)) {
        if (qw->rootObject())
            enqueue(qw->rootObject());
    }
#endif
    if (auto *win = qobject_cast<QQuickWindow*>(obj)) {
        if (win->contentItem())
            enqueue(win->contentItem());
    }
    for (auto *child : obj->children())
        enqueue(child);
}

// --- Networking ---

// How the places are shared, so that nobody can lock a client out by holding connections open:
//
// Without a token every connection may send commands at once. There are kMaxClients places. When one more
// connection comes, the one that was idle the longest is closed, with a line that says why.
//
// With a token there are two groups. A connection that has not sent the token yet waits: at most kMaxWaiting
// at a time, each for at most the auth timeout. When one more comes, the one that waits the longest is closed.
// A waiting connection never takes a place from one that has sent the token. The connections that have sent
// the token have kMaxClients places of their own; when one more passes the check, the one of them that was
// idle the longest is closed.
//
// What stays possible: without a token, any program on the device can send commands and can push other
// clients out (they connect again). With a token, a program without it can only push out connections that
// are still waiting. A client that sends the token right after it connects waits for one round trip only.
void InspectorServer::onNewConnection()
{
    if (!m_clock.isValid())
        m_clock.start();
    const bool needsToken = !m_authToken.isEmpty();
    while (m_server->hasPendingConnections()) {
        QTcpSocket *socket = m_server->nextPendingConnection();
        if (needsToken) {
            if (waitingCount() >= kMaxWaiting) {
                // A token that has arrived already is checked first, so that its connection is not the one that goes.
                const QList<QTcpSocket*> clients = m_clients;
                for (QTcpSocket *waiting : clients) {
                    if (m_clients.contains(waiting) && !m_authenticated.contains(waiting) && waiting->bytesAvailable() > 0)
                        readFrom(waiting);
                }
            }
            if (waitingCount() >= kMaxWaiting)
                drop(longestIdle(false), QStringLiteral("Connection closed: too many connections wait for the token check. "
                                                        "Send the token right after connecting."));
        } else if (m_clients.size() >= kMaxClients) {
            drop(longestIdle(true), QStringLiteral("Connection closed: there are more than %1 connections, and this one was idle the longest. "
                                                   "Connect again to go on.").arg(kMaxClients));
        }
        m_clients.append(socket);
        m_buffers[socket] = QByteArray();
        m_lastActive[socket] = m_clock.elapsed();
        connect(socket, &QTcpSocket::readyRead, this, &InspectorServer::onReadyRead);
        connect(socket, &QTcpSocket::disconnected, this, &InspectorServer::onClientDisconnected);
        qInfo() << "[QmlInspector] Client connected from" << socket->peerAddress().toString();
        // A connection that does not send the token in time is closed.
        if (needsToken) {
            QTimer::singleShot(m_authTimeoutMs, socket, [this, socket]() {
                if (m_clients.contains(socket) && !m_authenticated.contains(socket))
                    refuse(socket, -1, QStringLiteral("Authentication required: no token was sent in time"));
            });
        }
    }
}

int InspectorServer::waitingCount() const
{
    return m_clients.size() - m_authenticated.size();
}

// The connection that was idle the longest, among those that may send commands (`mayCommand`) or among those
// that still wait for the token check.
QTcpSocket *InspectorServer::longestIdle(bool mayCommand) const
{
    const bool needsToken = !m_authToken.isEmpty();
    QTcpSocket *found = nullptr;
    for (QTcpSocket *socket : m_clients) {
        if (needsToken && m_authenticated.contains(socket) != mayCommand)
            continue;
        if (!found || m_lastActive.value(socket) < m_lastActive.value(found))
            found = socket;
    }
    return found;
}

// Closes a connection to make room, with one line that says why. The line has no id: it answers no request.
void InspectorServer::drop(QTcpSocket *socket, const QString &reason)
{
    if (!socket)
        return;
    qWarning().noquote() << "[QmlInspector]" << reason;
    m_clients.removeAll(socket);
    m_buffers.remove(socket);
    m_authenticated.remove(socket);
    m_lastActive.remove(socket);
    disconnect(socket, nullptr, this, nullptr);
    connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
    sendResponse(socket, errorResult(reason));
    socket->disconnectFromHost();
    if (socket->state() == QAbstractSocket::UnconnectedState)
        socket->deleteLater();
}

void InspectorServer::onReadyRead()
{
    if (QTcpSocket *socket = qobject_cast<QTcpSocket*>(sender()))
        readFrom(socket);
}

void InspectorServer::readFrom(QTcpSocket *socket)
{
    m_buffers[socket].append(socket->readAll());
    m_lastActive[socket] = m_clock.elapsed();

    const bool needsToken = !m_authToken.isEmpty();

    // Process newline-delimited JSON messages
    while (true) {
        const bool authenticated = !needsToken || m_authenticated.contains(socket);
        int idx = m_buffers[socket].indexOf('\n');
        if (!authenticated && (idx < 0 ? m_buffers[socket].size() : idx) > kMaxLineBeforeAuth) {
            refuse(socket, -1, QStringLiteral("Authentication required: send the auth command with the token first"));
            return;
        }
        if (idx < 0) break;

        QByteArray line = m_buffers[socket].left(idx).trimmed();
        m_buffers[socket].remove(0, idx + 1);

        if (line.isEmpty()) continue;

        QJsonParseError err;
        QJsonDocument doc = QJsonDocument::fromJson(line, &err);
        if (err.error != QJsonParseError::NoError || !doc.isObject()) {
            QJsonObject errResp;
            errResp["error"] = QString("Parse error: %1").arg(err.errorString());
            sendResponse(socket, errResp);
            continue;
        }

        QJsonObject request = doc.object();

        // The token check. It is here and not in handleCommand, because it belongs
        // to the connection: the relay client has its own check.
        if (request.value("command").toString() == QLatin1String("auth")) {
            const int id = request.value("id").toInt(-1);
            const QByteArray given = request.value("params").toObject().value("token").toString().toUtf8();
            if (needsToken && !sameToken(m_authToken, given)) {
                qWarning("[QmlInspector] A client sent a wrong token; connection closed");
                refuse(socket, id, QStringLiteral("Authentication failed: wrong token"));
                return;
            }
            if (needsToken && !m_authenticated.contains(socket)) {
                if (m_authenticated.size() >= kMaxClients)
                    drop(longestIdle(true), QStringLiteral("Connection closed: there are more than %1 connections, and this one was idle the longest. "
                                                           "Connect again to go on.").arg(kMaxClients));
                m_authenticated.insert(socket);
            }
            QJsonObject reply = okResult({{"auth", needsToken ? "accepted" : "not required"}});
            if (id >= 0)
                reply["id"] = id;
            sendResponse(socket, reply);
            continue;
        }
        if (!authenticated) {
            qWarning("[QmlInspector] A client sent a command without the token; connection closed");
            refuse(socket, request.value("id").toInt(-1),
                   QStringLiteral("Authentication required: send the auth command with the token first"));
            return;
        }

        QJsonObject response = handleCommand(request);
        // The command can have ended this connection (the server was stopped from inside the app).
        if (!m_clients.contains(socket))
            return;
        sendResponse(socket, response);
    }
}

void InspectorServer::onClientDisconnected()
{
    QTcpSocket *socket = qobject_cast<QTcpSocket*>(sender());
    if (!socket) return;

    m_clients.removeAll(socket);
    m_buffers.remove(socket);
    m_authenticated.remove(socket);
    m_lastActive.remove(socket);
    socket->deleteLater();
    qInfo() << "[QmlInspector] Client disconnected";
}

// One error line, then the connection is closed. Nothing more is read from it.
void InspectorServer::refuse(QTcpSocket *socket, int id, const QString &message)
{
    QJsonObject reply = errorResult(message);
    if (id >= 0)
        reply["id"] = id;
    m_buffers[socket].clear();
    sendResponse(socket, reply);
    socket->disconnectFromHost();
}

void InspectorServer::sendResponse(QTcpSocket *socket, const QJsonObject &response)
{
    QByteArray data = QJsonDocument(response).toJson(QJsonDocument::Compact);
    data.append('\n');
    socket->write(data);
    socket->flush();
}

// --- Command dispatch ---

QJsonObject InspectorServer::handleCommand(const QJsonObject &request)
{
    QString command = request.value("command").toString();
    QJsonObject params = request.value("params").toObject();
    int id = request.value("id").toInt(-1);

    QJsonObject result;

    // What password fields hold is left out of every reply. Their texts are looked up when the first text
    // of a reply is checked (see secrets()), and not before: a command that sends no text back, such as a
    // read of "pressed", does not walk the tree for it. They are looked up again for each command.
    m_secretsCollected = false;

    if (command == "getTree")
        result = cmdGetTree(params);
    else if (command == "getProperties")
        result = cmdGetProperties(params);
    else if (command == "setProperty")
        result = cmdSetProperty(params);
    else if (command == "callMethod")
        result = cmdCallMethod(params);
    else if (command == "findByType")
        result = cmdFindByType(params);
    else if (command == "findByProperty")
        result = cmdFindByProperty(params);
    else if (command == "screenshot")
        result = cmdScreenshot(params);
    else if (command == "click")
        result = cmdClick(params);
    else if (command == "sendKeys")
        result = cmdSendKeys(params);
    else if (command == "mouse")
        result = cmdMouse(params);
    else if (command == "geometry")
        result = cmdGeometry(params);
    else if (command == "wheel")
        result = cmdWheel(params);
    else if (command == "evaluate")
        result = cmdEvaluate(params);
    else if (command == "findAndClick")
        result = cmdFindAndClick(params);
    else if (command == "listInteractive")
        result = cmdListInteractive(params);
    else if (command == "listFileDialogs")
        result = cmdListFileDialogs(params);
    else if (command == "fileDialogAction")
        result = cmdFileDialogAction(params);
    else
        result = errorResult(QString("Unknown command: %1").arg(command));

    // Tells a client that this plugin hides the text of password fields itself.
    if (isOk(result))
        result["secretsHidden"] = true;

    if (id >= 0)
        result["id"] = id;

    return result;
}

// --- Hidden text ---

// A text field that hides what is typed: its echoMode is not Normal (0).
// QQuickTextInput (TextInput, TextField) and QLineEdit have this property.
static bool isEchoField(QObject *obj)
{
    return obj->inherits("QQuickTextInput") || obj->inherits("QLineEdit");
}

static bool hidesText(QObject *obj)
{
    if (!isEchoField(obj))
        return false;
    const QVariant mode = obj->property("echoMode");
    return mode.isValid() && mode.toInt() != 0;
}

// The properties of such a field that hold what was typed.
static bool isTypedTextProperty(const QByteArray &name)
{
    return name == "text" || name == "displayText" || name == "selectedText" || name == "preeditText";
}

// A wrapper often repeats the text of its field in a property of its own (an alias).
// So the texts are collected first, and every string property that equals one of them is hidden too.
void InspectorServer::collectSecrets()
{
    m_secrets.clear();
    QList<QObject*> stack;
    QSet<QObject*> visited;
    auto enqueue = [&](QObject *o) {
        if (o && !visited.contains(o)) {
            visited.insert(o);
            stack.append(o);
        }
    };
    for (QObject *root : rootObjects())
        enqueue(root);
    while (!stack.isEmpty()) {
        QObject *obj = stack.takeFirst();
        if (hidesText(obj)) {
            const QString text = obj->property("text").toString();
            if (!text.isEmpty())
                m_secrets.insert(text);
        }
        enqueueChildren(obj, enqueue);
    }
}

// The texts that password fields hold now. Collected once per command, on first use.
const QSet<QString> &InspectorServer::secrets()
{
    if (!m_secretsCollected) {
        collectSecrets();
        m_secretsCollected = true;
    }
    return m_secrets;
}

// Only a text that equals what a password field holds is hidden. A text that contains it, or is made from it,
// is not.
bool InspectorServer::isSecretValue(const QVariant &value)
{
    if (value.typeId() != QMetaType::QString)
        return false;
    const QString text = value.toString();
    return !text.isEmpty() && secrets().contains(text);
}

// The same for a value that can hold texts inside it (a list, a map).
bool InspectorServer::holdsSecret(const QVariant &value)
{
    switch (value.typeId()) {
    case QMetaType::QString:
        return isSecretValue(value);
    case QMetaType::QStringList: {
        const QStringList list = value.toStringList();
        for (const QString &entry : list)
            if (isSecretValue(entry))
                return true;
        return false;
    }
    case QMetaType::QVariantList: {
        const QVariantList list = value.toList();
        for (const QVariant &entry : list)
            if (holdsSecret(entry))
                return true;
        return false;
    }
    case QMetaType::QVariantMap: {
        const QVariantMap map = value.toMap();
        for (auto it = map.begin(); it != map.end(); ++it)
            if (holdsSecret(it.value()))
                return true;
        return false;
    }
    case QMetaType::Bool:
    case QMetaType::Int:
    case QMetaType::UInt:
    case QMetaType::Long:
    case QMetaType::ULong:
    case QMetaType::LongLong:
    case QMetaType::ULongLong:
    case QMetaType::Short:
    case QMetaType::UShort:
    case QMetaType::Float:
    case QMetaType::Double:
        return false;
    default:
        if (value.userType() == qMetaTypeId<QJSValue>()) {
            const QVariant inner = value.value<QJSValue>().toVariant();
            return inner.userType() != qMetaTypeId<QJSValue>() && holdsSecret(inner);
        }
        // Every other value is sent as its text (see variantToJson).
        return value.canConvert<QString>() && isSecretValue(value.toString());
    }
}

// --- Command handlers ---

QJsonObject InspectorServer::cmdGetTree(const QJsonObject &params)
{
    int depth = params.value("depth").toInt(4);
    QString objectId = params.value("objectId").toString();

    if (objectId.isEmpty() && !m_root) {
        // Pure-QML app: a synthetic root over every top-level window.
        QJsonObject tree;
        tree["id"] = "";
        tree["type"] = QString::fromUtf8(qApp ? qApp->metaObject()->className() : "QGuiApplication");
        tree["objectName"] = qApp ? qApp->applicationName() : QString();
        QJsonArray children;
        for (QObject *win : rootObjects())
            children.append(serializeObject(win, depth, 1));
        tree["children"] = children;
        tree["childCount"] = children.size();
        return okResult({{"tree", tree}, {"states", true}});
    }

    QObject *root = objectId.isEmpty() ? m_root.data() : resolveObject(objectId);
    if (!root)
        return errorResult("Root object not found");

    return okResult({{"tree", serializeObject(root, depth)}, {"states", true}});
}

QJsonObject InspectorServer::cmdGetProperties(const QJsonObject &params)
{
    QString objectId = params.value("objectId").toString();
    QObject *obj = resolveObject(objectId);
    if (!obj)
        return errorResult("Object not found: " + objectId);

    QJsonObject data;
    data["objectId"] = objectId;
    data["type"] = QString::fromUtf8(obj->metaObject()->className());
    data["objectName"] = obj->objectName();

    // With "names", only these properties are read. Reading every property runs every getter of the object;
    // on an object of a page that is being replaced this has made an app exit. A client that needs two values
    // should ask for two.
    if (params.contains("names")) {
        const QMetaObject *meta = obj->metaObject();
        const bool hides = hidesText(obj);
        QJsonArray props;
        const QJsonArray names = params.value("names").toArray();
        for (const QJsonValue &entry : names) {
            const QByteArray name = entry.toString().toUtf8();
            const QVariant value = obj->property(name.constData());
            if (name.isEmpty() || !value.isValid())
                continue;
            const int index = meta->indexOfProperty(name.constData());
            QJsonObject p;
            p["name"] = QString::fromUtf8(name);
            p["type"] = index >= 0 ? QString::fromUtf8(meta->property(index).typeName()) : QStringLiteral("dynamic");
            if ((hides && isTypedTextProperty(name)) || isSecretValue(value)) {
                p["value"] = QJsonValue::Null;
                p["hidden"] = true;
            } else {
                p["value"] = variantToJson(value);
            }
            p["writable"] = index >= 0 ? meta->property(index).isWritable() : true;
            props.append(p);
        }
        data["properties"] = props;
        return okResult(data);
    }

    data["properties"] = serializeProperties(obj);

    // List methods/slots
    QJsonArray methods;
    const QMetaObject *meta = obj->metaObject();
    for (int i = meta->methodOffset(); i < meta->methodCount(); ++i) {
        QMetaMethod m = meta->method(i);
        if (m.access() != QMetaMethod::Public) continue;

        QJsonObject mobj;
        mobj["name"] = QString::fromUtf8(m.name());
        mobj["signature"] = QString::fromUtf8(m.methodSignature());
        mobj["returnType"] = QString::fromUtf8(m.typeName());
        switch (m.methodType()) {
            case QMetaMethod::Signal: mobj["kind"] = "signal"; break;
            case QMetaMethod::Slot:   mobj["kind"] = "slot"; break;
            default:                  mobj["kind"] = "method"; break;
        }
        methods.append(mobj);
    }
    data["methods"] = methods;

    return okResult(data);
}

QJsonObject InspectorServer::cmdSetProperty(const QJsonObject &params)
{
    QString objectId = params.value("objectId").toString();
    QString propName = params.value("property").toString();
    QJsonValue jsonVal = params.value("value");

    QObject *obj = resolveObject(objectId);
    if (!obj)
        return errorResult("Object not found: " + objectId);

    // Try meta-property first for proper type conversion
    const QMetaObject *meta = obj->metaObject();
    int propIdx = meta->indexOfProperty(propName.toUtf8().constData());

    QVariant newVal;
    if (propIdx >= 0) {
        QMetaProperty prop = meta->property(propIdx);
        if (!prop.isWritable())
            return errorResult(QString("Property '%1' is not writable").arg(propName));

        // Convert JSON value based on property type
        newVal = jsonVal.toVariant();
        if (!prop.write(obj, newVal))
            return errorResult(QString("Failed to set property '%1'").arg(propName));
    } else {
        // Dynamic property
        obj->setProperty(propName.toUtf8().constData(), jsonVal.toVariant());
    }

    // Read back the value to confirm
    QVariant readBack = obj->property(propName.toUtf8().constData());
    return okResult({
        {"objectId", objectId},
        {"property", propName},
        {"value", variantToJson(readBack)}
    });
}

QJsonObject InspectorServer::cmdCallMethod(const QJsonObject &params)
{
    QString objectId = params.value("objectId").toString();
    QString methodName = params.value("method").toString();
    QJsonArray args = params.value("args").toArray();

    QObject *obj = resolveObject(objectId);
    if (!obj)
        return errorResult("Object not found: " + objectId);

    // Find the method
    const QMetaObject *meta = obj->metaObject();
    int methodIdx = -1;
    for (int i = 0; i < meta->methodCount(); ++i) {
        QMetaMethod m = meta->method(i);
        if (m.name() == methodName.toUtf8() && m.parameterCount() == args.size()) {
            methodIdx = i;
            break;
        }
    }

    if (methodIdx < 0) {
        // Try invoking by name with no args check (for Q_INVOKABLE)
        bool ok = false;
        if (args.isEmpty()) {
            ok = QMetaObject::invokeMethod(obj, methodName.toUtf8().constData(),
                                            Qt::DirectConnection);
        }
        if (ok) return okResult({{"invoked", methodName}});
        return errorResult(QString("Method '%1' not found with %2 args")
                           .arg(methodName).arg(args.size()));
    }

    // Build variant args list
    QVariantList vargs;
    for (const auto &a : args)
        vargs.append(a.toVariant());

    // Invoke using QMetaMethod with the correct number of arguments
    QMetaMethod method = meta->method(methodIdx);
    bool ok = false;
    switch (vargs.size()) {
    case 0:
        ok = method.invoke(obj, Qt::DirectConnection);
        break;
    case 1:
        ok = method.invoke(obj, Qt::DirectConnection,
                           Q_ARG(QVariant, vargs[0]));
        break;
    case 2:
        ok = method.invoke(obj, Qt::DirectConnection,
                           Q_ARG(QVariant, vargs[0]),
                           Q_ARG(QVariant, vargs[1]));
        break;
    case 3:
        ok = method.invoke(obj, Qt::DirectConnection,
                           Q_ARG(QVariant, vargs[0]),
                           Q_ARG(QVariant, vargs[1]),
                           Q_ARG(QVariant, vargs[2]));
        break;
    case 4:
        ok = method.invoke(obj, Qt::DirectConnection,
                           Q_ARG(QVariant, vargs[0]),
                           Q_ARG(QVariant, vargs[1]),
                           Q_ARG(QVariant, vargs[2]),
                           Q_ARG(QVariant, vargs[3]));
        break;
    default:
        return errorResult(QString("Too many arguments (%1), max 4 supported").arg(vargs.size()));
    }

    if (!ok)
        return errorResult(QString("Failed to invoke '%1'").arg(methodName));

    return okResult({{"invoked", methodName}});
}

QJsonObject InspectorServer::cmdFindByType(const QJsonObject &params)
{
    QString typeName = params.value("typeName").toString();
    if (typeName.isEmpty())
        return errorResult("typeName is required");

    QString error;
    const QList<QObject*> seeds = searchSeeds(params, &error);
    if (seeds.isEmpty())
        return errorResult(error);

    QJsonArray matches;
    for (QObject *seed : seeds)
        for (const auto &m : findByType(typeName, seed))
            matches.append(m);
    return okResult({{"matches", matches}, {"count", matches.size()}});
}

QJsonObject InspectorServer::cmdFindByProperty(const QJsonObject &params)
{
    QString propName = params.value("property").toString();
    if (propName.isEmpty())
        return errorResult("property is required");

    QJsonValue matchValue = params.value("value");
    bool hasMatchValue = params.contains("value");

    QString error;
    const QList<QObject*> seeds = searchSeeds(params, &error);
    if (seeds.isEmpty())
        return errorResult(error);

    QJsonArray results;
    QList<QObject*> stack;
    QSet<QObject*> visited;
    auto enqueue = [&](QObject *o) {
        if (o && !visited.contains(o)) {
            visited.insert(o);
            stack.append(o);
        }
    };
    for (QObject *seed : seeds)
        enqueue(seed);

    while (!stack.isEmpty()) {
        QObject *obj = stack.takeFirst();
        if (!obj) continue;

        QVariant val = obj->property(propName.toUtf8().constData());
        // A hidden value is never compared: a match would tell the client what it is.
        const bool hidden = val.isValid()
            && ((isTypedTextProperty(propName.toUtf8()) && hidesText(obj)) || isSecretValue(val));
        // The same for a list or a map that holds such a text.
        if (hasMatchValue && (hidden || (val.isValid() && holdsSecret(val)))) {
            enqueueChildren(obj, enqueue);
            continue;
        }
        if (val.isValid()) {
            bool matches = !hasMatchValue || variantToJson(val) == matchValue;
            // Fallback: compare as strings (handles int/string mismatches like QML text bound to int)
            if (!matches && hasMatchValue && val.canConvert<QString>()) {
                QString valStr = val.toString();
                QString matchStr = matchValue.isDouble()
                    ? QString::number(matchValue.toInt())
                    : matchValue.toString();
                matches = (valStr == matchStr);
            }
            if (matches) {
                QJsonObject entry = serializeObject(obj, 0, 0);
                entry["value"] = hidden ? QJsonValue(QJsonValue::Null) : variantToJson(val);
                if (hidden)
                    entry["hidden"] = true;
                results.append(entry);
            }
        }

        enqueueChildren(obj, enqueue);
    }

    return okResult({{"matches", results}, {"count", results.size()}});
}

QJsonObject InspectorServer::cmdScreenshot(const QJsonObject &params)
{
    QString objectId = params.value("objectId").toString();
    QObject *target = objectId.isEmpty() ? defaultRoot() : resolveObject(objectId);
    if (!target)
        return errorResult(objectId.isEmpty() ? "No root object for screenshot"
                                              : "Object not found: " + objectId);

    QImage image;
    if (auto *w = qobject_cast<QWidget*>(target)) {
        image = w->grab().toImage();
    } else if (auto *win = qobject_cast<QQuickWindow*>(target)) {
        image = win->grabWindow();
    } else if (auto *item = qobject_cast<QQuickItem*>(target)) {
        QQuickWindow *win = item->window();
        if (!win)
            return errorResult("Item has no window");
        image = win->grabWindow();
        const qreal dpr = image.devicePixelRatio() > 0 ? image.devicePixelRatio() : 1.0;
        QRectF scene = item->mapRectToScene(QRectF(0, 0, item->width(), item->height()));
        QRect px = QRectF(scene.x() * dpr, scene.y() * dpr,
                          scene.width() * dpr, scene.height() * dpr).toRect()
                   .intersected(image.rect());
        image = image.copy(px);
    } else {
        return errorResult("Cannot screenshot this object type");
    }

    QByteArray ba;
    QBuffer buf(&ba);
    buf.open(QIODevice::WriteOnly);
    image.save(&buf, "PNG");

    return okResult({
        {"image", QString::fromLatin1(ba.toBase64())},
        {"width", image.width()},
        {"height", image.height()},
        {"format", "png"}
    });
}

static void injectClick(QWindow *win, const QPointF &pos, Qt::MouseButton button);

QJsonObject InspectorServer::cmdClick(const QJsonObject &params)
{
    QString objectId = params.value("objectId").toString();
    QObject *obj = objectId.isEmpty() ? nullptr : resolveObject(objectId);
    if (!objectId.isEmpty() && !obj)
        return errorResult("Object not found: " + objectId);

    // Widget path (unchanged from upstream): post to the deepest child widget.
    QWidget *widgetTarget = qobject_cast<QWidget*>(obj);
    if (!obj && qobject_cast<QWidget*>(m_root.data()))
        widgetTarget = qobject_cast<QWidget*>(m_root.data());
    if (widgetTarget) {
        double x = params.contains("x") ? params.value("x").toDouble() : widgetTarget->width() / 2.0;
        double y = params.contains("y") ? params.value("y").toDouble() : widgetTarget->height() / 2.0;
        QPointF pos(x, y);
        QPointF globalPos = widgetTarget->mapToGlobal(pos.toPoint());
        QWidget *child = widgetTarget->childAt(pos.toPoint());
        if (child) {
            pos = child->mapFrom(widgetTarget, pos.toPoint());
            globalPos = child->mapToGlobal(pos.toPoint());
            widgetTarget = child;
        }
        QApplication::postEvent(widgetTarget, new QMouseEvent(
            QEvent::MouseButtonPress, pos, globalPos, Qt::LeftButton, Qt::LeftButton, Qt::NoModifier));
        QApplication::postEvent(widgetTarget, new QMouseEvent(
            QEvent::MouseButtonRelease, pos, globalPos, Qt::LeftButton, Qt::NoButton, Qt::NoModifier));
        return okResult({{"clicked", true}, {"x", x}, {"y", y},
                         {"widget", QString::fromUtf8(widgetTarget->metaObject()->className())}});
    }

    // Pure-QML path: post a press/release pair to the QQuickWindow in scene coordinates.
    QQuickWindow *win = nullptr;
    QPointF pos;
    if (auto *item = qobject_cast<QQuickItem*>(obj)) {
        win = item->window();
        if (!win)
            return errorResult("Item has no window");
        QPointF local(params.contains("x") ? params.value("x").toDouble() : item->width() / 2.0,
                      params.contains("y") ? params.value("y").toDouble() : item->height() / 2.0);
        pos = item->mapToScene(local);
    } else if (auto *w = qobject_cast<QQuickWindow*>(obj)) {
        win = w;
        pos = QPointF(params.contains("x") ? params.value("x").toDouble() : w->width() / 2.0,
                      params.contains("y") ? params.value("y").toDouble() : w->height() / 2.0);
    } else if (!obj) {
        win = quickWindowFor(nullptr);
        if (!win)
            return errorResult("No window to click in");
        pos = QPointF(params.value("x").toDouble(), params.value("y").toDouble());
    } else {
        return errorResult("Cannot click on this object type");
    }

    injectClick(win, pos, Qt::LeftButton);

    return okResult({{"clicked", true}, {"x", pos.x()}, {"y", pos.y()},
                     {"window", QString::fromUtf8(win->metaObject()->className())}});
}

// Input enters where the platform plugin hands it to Qt, as QTest does on a QWindow,
// so grabs, hover, focus and shortcuts behave as for real input. QtGui exports these
// functions for QTest; they are not in a public header.
Q_GUI_EXPORT void qt_handleMouseEvent(QWindow *window, const QPointF &local, const QPointF &global,
                                      Qt::MouseButtons state, Qt::MouseButton button,
                                      QEvent::Type type, Qt::KeyboardModifiers mods, int timestamp);
Q_GUI_EXPORT void qt_handleKeyEvent(QWindow *w, QEvent::Type t, int k, Qt::KeyboardModifiers mods,
                                    const QString &text, bool autorep, ushort count);
Q_GUI_EXPORT bool qt_sendShortcutOverrideEvent(QObject *o, ulong timestamp, int k, Qt::KeyboardModifiers mods,
                                               const QString &text, bool autorep, ushort count);
Q_GUI_EXPORT void qt_handleWheelEvent(QWindow *window, const QPointF &local, const QPointF &global,
                                      QPoint pixelDelta, QPoint angleDelta, Qt::KeyboardModifiers mods,
                                      Qt::ScrollPhase phase);

static int s_inputTime = 1000;
// Longer than the double-click interval, so two separate clicks are not one double click.
static const int kClickGapMs = 600;
static Qt::MouseButtons s_buttonsDown = Qt::NoButton;

// Deliver what was queued, without reading this server's own sockets again.
static void flushInput()
{
    QCoreApplication::processEvents(QEventLoop::ExcludeSocketNotifiers);
}

static void injectMouse(QWindow *win, const QPointF &pos, QEvent::Type type, Qt::MouseButton button)
{
    if (type == QEvent::MouseButtonPress)
        s_buttonsDown |= button;
    else if (type == QEvent::MouseButtonRelease)
        s_buttonsDown &= ~button;
    s_inputTime += 1;
    qt_handleMouseEvent(win, pos, win->mapToGlobal(pos), s_buttonsDown, button, type, Qt::NoModifier, s_inputTime);
}

static void injectClick(QWindow *win, const QPointF &pos, Qt::MouseButton button)
{
    injectMouse(win, pos, QEvent::MouseMove, Qt::NoButton);
    injectMouse(win, pos, QEvent::MouseButtonPress, button);
    injectMouse(win, pos, QEvent::MouseButtonRelease, button);
    s_inputTime += kClickGapMs;
    flushInput();
}

static void injectKey(QWindow *win, int key, Qt::KeyboardModifiers mods, const QString &text)
{
    s_inputTime += 1;
    if (!qt_sendShortcutOverrideEvent(win, s_inputTime, key, mods, text, false, 1))
        qt_handleKeyEvent(win, QEvent::KeyPress, key, mods, text, false, 1);
    s_inputTime += 1;
    qt_handleKeyEvent(win, QEvent::KeyRelease, key, mods, text, false, 1);
    flushInput();
}

// The window and scene position for a mouse or wheel command: x and y are in the
// item's coordinates and default to its centre.
static bool sceneTarget(QObject *obj, const QJsonObject &params, QQuickWindow **win, QPointF *pos)
{
    auto *item = qobject_cast<QQuickItem*>(obj);
    if (!item || !item->window())
        return false;
    QPointF local(params.contains("x") ? params.value("x").toDouble() : item->width() / 2.0,
                  params.contains("y") ? params.value("y").toDouble() : item->height() / 2.0);
    *win = item->window();
    *pos = item->mapToScene(local);
    return true;
}

QJsonObject InspectorServer::cmdMouse(const QJsonObject &params)
{
    QObject *obj = resolveObject(params.value("objectId").toString());
    QQuickWindow *win = nullptr;
    QPointF pos;
    if (!obj || !sceneTarget(obj, params, &win, &pos))
        return errorResult("mouse needs the objectId of a QML item in a window");
    const QString action = params.value("action").toString("click");
    const QString name = params.value("button").toString("left");
    const Qt::MouseButton button = name == "right" ? Qt::RightButton : name == "middle" ? Qt::MiddleButton : Qt::LeftButton;
    if (action == "move") {
        injectMouse(win, pos, QEvent::MouseMove, Qt::NoButton);
        flushInput();
    } else if (action == "press") {
        injectMouse(win, pos, QEvent::MouseMove, Qt::NoButton);
        injectMouse(win, pos, QEvent::MouseButtonPress, button);
        flushInput();
    } else if (action == "release") {
        injectMouse(win, pos, QEvent::MouseButtonRelease, button);
        s_inputTime += kClickGapMs;
        flushInput();
    } else if (action == "click") {
        injectClick(win, pos, button);
    } else if (action == "doubleClick") {
        injectMouse(win, pos, QEvent::MouseMove, Qt::NoButton);
        for (int i = 0; i < 2; ++i) {
            injectMouse(win, pos, QEvent::MouseButtonPress, button);
            injectMouse(win, pos, QEvent::MouseButtonRelease, button);
        }
        s_inputTime += kClickGapMs;
        flushInput();
    } else {
        return errorResult("Unknown mouse action: " + action);
    }
    return okResult({{"action", action}, {"x", pos.x()}, {"y", pos.y()}});
}

// Computed here and not through `evaluate`: the QML engine crashes when asked about an
// object that is being destroyed, such as a closing popup. A popup answers with its popup item.
QJsonObject InspectorServer::cmdGeometry(const QJsonObject &params)
{
    QObject *obj = resolveObject(params.value("objectId").toString());
    if (!obj)
        return errorResult("Object not found");
    auto *item = qobject_cast<QQuickItem*>(obj);
    if (!item && obj->inherits("QQuickPopup")) {
        if (auto *content = qobject_cast<QQuickItem*>(obj->property("contentItem").value<QObject*>()))
            item = content->parentItem();
    }
    if (!item || !item->window())
        return errorResult("Object has no place in a window");
    const QPointF scene = item->mapToScene(QPointF(0, 0));
    const QPointF global = item->mapToGlobal(QPointF(0, 0));
    return okResult({{"sceneX", scene.x()}, {"sceneY", scene.y()}, {"globalX", global.x()}, {"globalY", global.y()},
                     {"width", item->width()}, {"height", item->height()}});
}

QJsonObject InspectorServer::cmdWheel(const QJsonObject &params)
{
    QObject *obj = resolveObject(params.value("objectId").toString());
    QQuickWindow *win = nullptr;
    QPointF pos;
    if (!obj || !sceneTarget(obj, params, &win, &pos))
        return errorResult("wheel needs the objectId of a QML item in a window");
    const QPoint angle(params.value("dx").toInt(), params.value("dy").toInt());
    qt_handleWheelEvent(win, pos, win->mapToGlobal(pos), QPoint(), angle, Qt::NoModifier, Qt::NoScrollPhase);
    flushInput();
    return okResult({{"x", pos.x()}, {"y", pos.y()}, {"dy", angle.y()}});
}

QJsonObject InspectorServer::cmdSendKeys(const QJsonObject &params)
{
    QString text = params.value("text").toString();
    QString keyName = params.value("key").toString();
    if (text.isEmpty() && keyName.isEmpty())
        return errorResult("text or key is required");

    if (!QApplication::focusWidget()) {
        QPointer<QQuickItem> keyItem = qobject_cast<QQuickItem*>(resolveObject(params.value("objectId").toString()));
        QWindow *keyWindow = keyItem && keyItem->window() ? keyItem->window() : QGuiApplication::focusWindow();
        if (!keyWindow)
            keyWindow = quickWindowFor(nullptr);
        // Something else, a page that finished loading for one, can take the focus between two keys.
        auto injectKey = [&](QWindow *w, int key, Qt::KeyboardModifiers mods, const QString &keyText) {
            if (keyItem && !keyItem->hasActiveFocus())
                keyItem->forceActiveFocus();
            ::injectKey(w, key, mods, keyText);
        };
        if (keyWindow) {
            if (!keyName.isEmpty()) {
                const QKeySequence seq = QKeySequence::fromString(keyName);
                if (seq.isEmpty())
                    return errorResult("Unknown key: " + keyName);
                injectKey(keyWindow, seq[0].key(), seq[0].keyboardModifiers(), QString());
                return okResult({{"key", keyName}, {"target", "window"}});
            }
            for (const QChar &ch : text) {
                int key = ch.toUpper().unicode();
                QString keyText(ch);
                if (ch == QLatin1Char('\n') || ch == QLatin1Char('\r')) { key = Qt::Key_Return; keyText = QStringLiteral("\r"); }
                else if (ch == QLatin1Char('\t')) { key = Qt::Key_Tab; }
                else if (ch == QLatin1Char('\b')) { key = Qt::Key_Backspace; keyText.clear(); }
                injectKey(keyWindow, key, ch.isUpper() ? Qt::ShiftModifier : Qt::NoModifier, keyText);
            }
            return okResult({{"sent", text}, {"target", "window"}});
        }
    }
    QObject *target = QApplication::focusWidget();
    if (!target)
        target = QGuiApplication::focusWindow();
    if (!target)
        target = defaultRoot();
    if (!target)
        return errorResult("No focus widget or window");

    if (!keyName.isEmpty()) {
        // A named key such as Return, Escape, Tab, Backspace, Ctrl+A.
        QKeySequence seq = QKeySequence::fromString(keyName);
        if (seq.isEmpty())
            return errorResult("Unknown key: " + keyName);
        const QKeyCombination combo = seq[0];
        QKeyEvent press(QEvent::KeyPress, combo.key(), combo.keyboardModifiers());
        QKeyEvent release(QEvent::KeyRelease, combo.key(), combo.keyboardModifiers());
        QCoreApplication::sendEvent(target, &press);
        QCoreApplication::sendEvent(target, &release);
        return okResult({{"key", keyName}, {"target", QString::fromUtf8(target->metaObject()->className())}});
    }

    for (const QChar &ch : text) {
        int key = ch.unicode();
        Qt::KeyboardModifiers mods = Qt::NoModifier;
        if (ch.isUpper())
            mods = Qt::ShiftModifier;
        QString keyText(ch);
        if (ch == QLatin1Char('\n') || ch == QLatin1Char('\r')) {
            key = Qt::Key_Return;
            keyText = QStringLiteral("\r");
        } else if (ch == QLatin1Char('\t')) {
            key = Qt::Key_Tab;
        } else if (ch == QLatin1Char('\b')) {
            key = Qt::Key_Backspace;
            keyText.clear();
        }

        QKeyEvent press(QEvent::KeyPress, key, mods, keyText);
        QKeyEvent release(QEvent::KeyRelease, key, mods, keyText);
        QCoreApplication::sendEvent(target, &press);
        QCoreApplication::sendEvent(target, &release);
    }

    return okResult({{"sent", text}, {"target", QString::fromUtf8(target->metaObject()->className())}});
}

QJsonObject InspectorServer::cmdEvaluate(const QJsonObject &params)
{
    QString expression = params.value("expression").toString();
    if (expression.isEmpty())
        return errorResult("expression is required");

    QQmlEngine *engine = findQmlEngine();
    if (!engine)
        return errorResult("No QML engine found");

    // Find a root QML object to evaluate against
    QObject *contextObj = nullptr;
    QString objectId = params.value("objectId").toString();
    if (!objectId.isEmpty()) {
        contextObj = resolveObject(objectId);
    }

    if (!contextObj) {
        for (QObject *root : rootObjects()) {
            if (auto *widget = qobject_cast<QWidget*>(root)) {
#if QMLINSPECTOR_HAVE_QUICKWIDGETS
                // Widgets app: first QQuickWidget's root object
                for (auto *qw : widget->findChildren<QQuickWidget*>()) {
                    if (qw->rootObject()) {
                        contextObj = qw->rootObject();
                        break;
                    }
                }
#else
                Q_UNUSED(widget);
#endif
            } else if (QQmlEngine::contextForObject(root)) {
                // Pure-QML app: the window object the engine created
                contextObj = root;
            }
            if (contextObj) break;
        }
    }

    if (!contextObj)
        return errorResult("No QML context object found");

    QQmlContext *context = engine->contextForObject(contextObj);
    if (!context)
        context = engine->rootContext();
    // Evaluating in the context of an object that is being destroyed crashes the engine.
    if (!context->isValid())
        return errorResult("Object is being destroyed");

    QQmlExpression expr(context, contextObj, expression);
    bool valueIsUndefined = false;
    QVariant result = expr.evaluate(&valueIsUndefined);

    if (expr.hasError())
        return errorResult(QString("Evaluation error: %1").arg(expr.error().toString()));

    return okResult({
        {"result", variantToJson(result)},
        {"undefined", valueIsUndefined}
    });
}

QJsonObject InspectorServer::cmdFindAndClick(const QJsonObject &params)
{
    QString searchText = params.value("text").toString();
    if (searchText.isEmpty())
        return errorResult("text is required");

    QString filterType = params.value("type").toString();
    bool exact = params.value("exact").toBool(false);

    QString error;
    const QList<QObject*> seeds = searchSeeds(params, &error);
    if (seeds.isEmpty())
        return errorResult(error);

    QList<QObject*> stack;
    QSet<QObject*> visited;
    QJsonObject clickResult;
    auto enqueue = [&](QObject *o) {
        if (o && !visited.contains(o)) {
            visited.insert(o);
            stack.append(o);
        }
    };
    for (QObject *seed : seeds)
        enqueue(seed);

    while (!stack.isEmpty()) {
        QObject *obj = stack.takeFirst();
        if (!obj) continue;

        enqueueChildren(obj, enqueue);

        QVariant textVal = obj->property("text");
        if (!textVal.isValid() || hidesText(obj) || isSecretValue(textVal))
            continue;

        QString text = textVal.toString();
        bool textMatches = exact ? (text == searchText)
                                    : text.contains(searchText, Qt::CaseInsensitive);
        if (!textMatches)
            continue;

        bool typeMatches = true;
        if (!filterType.isEmpty()) {
            QString className = QString::fromUtf8(obj->metaObject()->className());
            typeMatches = (className == filterType || className.contains(filterType));
        }

        if (!typeMatches)
            continue;

        QString objectId = registerObject(obj);
        clickResult = cmdClick(QJsonObject{{"objectId", objectId}});
        if (isOk(clickResult)) {
            clickResult["matchedText"] = obj->property("text").toString();
            clickResult["matchedType"] = QString::fromUtf8(obj->metaObject()->className());
            clickResult["matchedId"] = objectId;
            break;
        }
    }

    if (!isOk(clickResult))
        return errorResult(QString("No clickable element found with text '%1'").arg(searchText));

    return clickResult;
}

QJsonObject InspectorServer::cmdListInteractive(const QJsonObject &params)
{
    QString error;
    const QList<QObject*> seeds = searchSeeds(params, &error);
    if (seeds.isEmpty())
        return errorResult(error);

    // Type substrings that indicate interactive elements
    static const QStringList interactiveTypes = {
        "Button", "Delegate", "TextField", "TextInput", "TextEdit",
        "ComboBox", "Slider", "Switch", "CheckBox", "RadioButton",
        "SpinBox", "TabButton", "MenuItem", "MouseArea"
    };

    QJsonArray results;
    QList<QObject*> stack;
    QSet<QObject*> visited;
    auto enqueue = [&](QObject *o) {
        if (o && !visited.contains(o)) {
            visited.insert(o);
            stack.append(o);
        }
    };
    for (QObject *seed : seeds)
        enqueue(seed);

    while (!stack.isEmpty()) {
        QObject *obj = stack.takeFirst();
        if (!obj) continue;

        QString className = QString::fromUtf8(obj->metaObject()->className());

        // Check if this is an interactive type
        bool isInteractive = false;
        for (const QString &itype : interactiveTypes) {
            if (className.contains(itype, Qt::CaseInsensitive)) {
                isInteractive = true;
                break;
            }
        }

        // Only include interactive elements that are visible
        if (isInteractive) {
            bool isVisible = false;
            QWidget *w = qobject_cast<QWidget*>(obj);
            QQuickItem *qitem = qobject_cast<QQuickItem*>(obj);
            if (w) isVisible = w->isVisible();
            else if (qitem) isVisible = qitem->isVisible();

            if (isVisible) {
                QString id = registerObject(obj);
                QJsonObject entry;
                entry["id"] = id;
                entry["type"] = className;
                entry["objectName"] = obj->objectName();

                QVariant textVal = obj->property("text");
                if (hidesText(obj) || isSecretValue(textVal))
                    entry["secret"] = true;
                else if (textVal.isValid() && !textVal.toString().isEmpty())
                    entry["text"] = textVal.toString();

                if (w) {
                    entry["enabled"] = w->isEnabled();
                    entry["geometry"] = QJsonObject{
                        {"x", w->x()}, {"y", w->y()},
                        {"width", w->width()}, {"height", w->height()}
                    };
                }
                if (qitem) {
                    entry["enabled"] = qitem->isEnabled();
                    entry["geometry"] = QJsonObject{
                        {"x", qitem->x()}, {"y", qitem->y()},
                        {"width", qitem->width()}, {"height", qitem->height()}
                    };
                }

                results.append(entry);
            }
        }

        enqueueChildren(obj, enqueue);
    }

    return okResult({{"elements", results}, {"count", results.size()}});
}

QJsonObject InspectorServer::cmdListFileDialogs(const QJsonObject &params) {
    Q_UNUSED(params);
    // There are many more dialog types, but we start with those to make
    // life simpler.
    static const QStringList fileDialogTypes = {
        "QFileDialog", "QQuickFileDialog"
    };

    QList<QObject*> roots;
    for (QWidget *w : QApplication::topLevelWidgets())
        roots.append(w);
    for (QObject *r : rootObjects())
        if (!roots.contains(r))
            roots.append(r);

    QJsonArray dialogs;
    for (const QString &dialogType : fileDialogTypes) {
        for (QObject *root : roots) {
            for (const auto &item : findByType(dialogType, root)) {
                dialogs.append(item);
            }
        }
    }
    return okResult({{"dialogs", dialogs}});
}

QJsonObject InspectorServer::cmdFileDialogAction(const QJsonObject &params)
{
    QString objectId = params.value("objectId").toString();
    QObject *obj = resolveObject(objectId);
    if (!obj)
        return errorResult("Object not found: " + objectId);

    QFileDialog *fDialog = qobject_cast<QFileDialog*>(obj);
    if (!fDialog && !obj->inherits("QQuickFileDialog")) {
        return errorResult("Object is not a file dialog: " + objectId);
    }

    // Since QQuickFileDialog requires that anyway,
    // just use invokeMethod all over for simplicity.
    QString action = params.value("action").toString();
    if (action == "accept") {
        QMetaObject::invokeMethod(obj, "accept");
    } else if (action == "cancel") {
        QMetaObject::invokeMethod(obj, "reject");
    } else if (action == "select") {
        if (fDialog) {
            fDialog->selectFile(params.value("path").toString());
        } else {
            QString fileUrl = "file://" + params.value("path").toString();
            if (!obj->setProperty("selectedFile", QUrl(fileUrl))) {
                qWarning() << "Failed to set selectedFile property on" << objectId;
            }
        }
    } else {
        return errorResult("Unknown action: " + action);
    }

    return okResult();
}

// --- Serialization ---

QJsonObject InspectorServer::serializeObject(QObject *obj, int maxDepth, int currentDepth)
{
    if (!obj)
        return QJsonObject();

    QString id = registerObject(obj);
    QJsonObject result;
    result["id"] = id;
    result["type"] = QString::fromUtf8(obj->metaObject()->className());
    result["objectName"] = obj->objectName();

    // The QML id, when the engine created the object (Squish object maps use it)
    if (QQmlContext *ctx = QQmlEngine::contextForObject(obj)) {
        const QString qmlId = ctx->nameForObject(obj);
        if (!qmlId.isEmpty())
            result["qmlId"] = qmlId;
    }

    // C++ ancestry, so a client can match a base type the way Squish reports it
    QJsonArray inherits;
    for (const QMetaObject *mo = obj->metaObject()->superClass(); mo; mo = mo->superClass())
        inherits.append(QString::fromUtf8(mo->className()));
    result["inherits"] = inherits;

    // Widget geometry
    QWidget *w = qobject_cast<QWidget*>(obj);
    if (w) {
        result["visible"] = w->isVisible();
        result["enabled"] = w->isEnabled();
        result["geometry"] = QJsonObject{
            {"x", w->x()}, {"y", w->y()},
            {"width", w->width()}, {"height", w->height()}
        };
    }

    // Top-level window geometry (QQuickWindow, QWindow)
    QWindow *win = qobject_cast<QWindow*>(obj);
    if (win) {
        result["visible"] = win->isVisible();
        result["active"] = win->isActive();
        // A title is a text of the app like any other: one that equals what a password field holds is left out.
        if (!isSecretValue(win->title()))
            result["title"] = win->title();
        result["geometry"] = QJsonObject{
            {"x", win->x()}, {"y", win->y()},
            {"width", win->width()}, {"height", win->height()}
        };
    }

    // QQuickItem geometry
    QQuickItem *item = qobject_cast<QQuickItem*>(obj);
    if (item) {
        result["visible"] = item->isVisible();
        result["enabled"] = item->isEnabled();
        result["geometry"] = QJsonObject{
            {"x", item->x()}, {"y", item->y()},
            {"width", item->width()}, {"height", item->height()}
        };
        result["opacity"] = item->opacity();
    }

    // QDialog geometry.
    QDialog *dialog = qobject_cast<QDialog*>(obj);
    if (dialog) {
        if (!isSecretValue(dialog->windowTitle()))
            result["title"] = dialog->windowTitle();
        result["visible"] = dialog->isVisible();
        result["geometry"] = QJsonObject{
            {"x", dialog->x()}, {"y", dialog->y()},
            {"width", dialog->width()}, {"height", dialog->height()}
        };
    }

    // QQuickFileDialog geometry.
    // We need to resort to the metaobject protocol as QQuickDialog has no
    // public C++ API. This is, of course, brittle, and might break with
    // (minor) future versions releases of Qt.
    // FIXME: this is getting pretty long, probably worth it to dismember this
    //   into type-specific and keep the main traversal logic clean.
    if (obj->inherits("QQuickAbstractDialog")) {
        if (!isSecretValue(obj->property("title")))
            result["title"] = obj->property("title").toString();
        result["visible"] = obj->property("visible").toBool();
        // Geometry is painful cause QML uses its own "real" type - I don't even
        // know if the coordinate system is the same as the rest - so TODO. :-)
    }

    // States that a client would otherwise ask for with one search of the whole tree each
    // ("checked", "activeFocus", "modal", "opened"). Only objects that can have the state are asked:
    // a visible item for "checked", a popup for "modal" and "opened".
    if (item) {
        if (item->hasActiveFocus())
            result["activeFocus"] = true;
        if (item->isVisible()) {
            const QVariant checked = obj->property("checked");
            if (checked.typeId() == QMetaType::Bool && checked.toBool())
                result["checked"] = true;
        }
    }
    if (obj->inherits("QQuickPopup")) {
        result["modal"] = obj->property("modal").toBool();
        result["opened"] = obj->property("opened").toBool();
    }
    // The item of an open popup is a child of the overlay; the popup object that owns it is not
    // in the item tree. So the item says which popup it belongs to.
    if (item && item->inherits("QQuickPopupItem") && item->parent() && item->parent()->inherits("QQuickPopup")) {
        QObject *popup = item->parent();
        QJsonObject p{
            {"id", registerObject(popup)},
            {"type", QString::fromUtf8(popup->metaObject()->className())},
            {"objectName", popup->objectName()},
            {"modal", popup->property("modal").toBool()},
            {"opened", popup->property("opened").toBool()}
        };
        const QVariant title = popup->property("title");
        if (title.typeId() == QMetaType::QString && !title.toString().isEmpty() && !isSecretValue(title))
            p["title"] = title.toString();
        result["popup"] = p;
    }
    // Where a list is scrolled to, and how far it can go.
    if (obj->inherits("QQuickFlickable")) {
        for (const char *name : {"contentX", "contentY", "contentWidth", "contentHeight", "originX", "originY"})
            result[QString::fromUtf8(name)] = obj->property(name).toDouble();
    }

    // Include common identifying properties in tree nodes
    static const char* identifyingProps[] = {
        "text", "title", "placeholderText", "source", "currentText", "label", nullptr
    };
    // A password field: its text is left out. "echoMode" is sent for every such field,
    // so a client can tell a field that shows its text from one that hides it.
    const bool hides = hidesText(obj);
    if (isEchoField(obj)) {
        result["echoMode"] = obj->property("echoMode").toInt();
        if (hides) {
            result["secret"] = true;
            result["textLength"] = obj->property("text").toString().size();
        }
    }
    for (int i = 0; identifyingProps[i]; ++i) {
        QVariant val = obj->property(identifyingProps[i]);
        if ((hides && isTypedTextProperty(identifyingProps[i])) || isSecretValue(val)) {
            result["secret"] = true;
            continue;
        }
        if (val.isValid()) {
            QJsonValue jv = variantToJson(val);
            if (!jv.isNull() && jv != QJsonValue(QString())) {
                result[QString::fromUtf8(identifyingProps[i])] = jv;
            }
        }
    }

    // Children
    if (currentDepth < maxDepth) {
        QJsonArray children;

#if QMLINSPECTOR_HAVE_QUICKWIDGETS
        // For QQuickWidget, include the QML root item
        QQuickWidget *qw = qobject_cast<QQuickWidget*>(obj);
        if (qw && qw->rootObject()) {
            children.append(serializeObject(qw->rootObject(), maxDepth, currentDepth + 1));
        }
#endif

        if (item) {
            // QQuickItem: use childItems() for visual children
            for (QQuickItem *child : item->childItems()) {
                children.append(serializeObject(child, maxDepth, currentDepth + 1));
            }
            // A popup (a dialog, a menu, a drawer) that is declared inside this item is an object,
            // not a child item. It is listed here, so that a client can find a closed drawer.
            // The content of an open popup is under the overlay: it is not listed a second time.
            for (QObject *child : obj->children()) {
                if (!child->inherits("QQuickPopup"))
                    continue;
                // The content of a closed popup is not on the screen, and there can be many closed dialogs and menus:
                // it is not sent with every tree. Only a closed Drawer is sent with its content, because a click
                // on one of its elements can open it. A client that wants the content of another popup asks for
                // the tree of that popup (getTree with its id).
                const bool open = child->property("opened").toBool() || child->property("visible").toBool();
                const bool withContent = !open && child->inherits("QQuickDrawer");
                children.append(serializeObject(child, withContent ? maxDepth : currentDepth + 1, currentDepth + 1));
            }
        } else {
            // QObject/QWidget/QWindow: use children(); a QQuickWindow's contentItem
            // is normally among them, but make sure it is listed.
            QList<QObject*> objChildren = obj->children();
            if (auto *quickWin = qobject_cast<QQuickWindow*>(obj)) {
                if (quickWin->contentItem() && !objChildren.contains(quickWin->contentItem()))
                    objChildren.append(quickWin->contentItem());
            }
            for (QObject *child : objChildren) {
                children.append(serializeObject(child, maxDepth, currentDepth + 1));
            }
        }

        result["children"] = children;
        result["childCount"] = children.size();
    } else {
        // Report child count without recursing
        if (item) {
            result["childCount"] = item->childItems().count();
        } else {
            result["childCount"] = obj->children().count();
        }
    }

    return result;
}

QJsonArray InspectorServer::serializeProperties(QObject *obj)
{
    QJsonArray props;
    const QMetaObject *meta = obj->metaObject();
    const bool hides = hidesText(obj);

    for (int i = 0; i < meta->propertyCount(); ++i) {
        QMetaProperty prop = meta->property(i);
        QJsonObject p;
        p["name"] = QString::fromUtf8(prop.name());
        p["type"] = QString::fromUtf8(prop.typeName());
        const QVariant value = prop.read(obj);
        if ((hides && isTypedTextProperty(prop.name())) || isSecretValue(value)) {
            p["value"] = QJsonValue::Null;
            p["hidden"] = true;
        } else {
            p["value"] = variantToJson(value);
        }
        p["writable"] = prop.isWritable();
        props.append(p);
    }

    // Dynamic properties
    for (const QByteArray &name : obj->dynamicPropertyNames()) {
        QJsonObject p;
        p["name"] = QString::fromUtf8(name);
        p["type"] = "dynamic";
        const QVariant value = obj->property(name.constData());
        if (isSecretValue(value)) {
            p["value"] = QJsonValue::Null;
            p["hidden"] = true;
        } else {
            p["value"] = variantToJson(value);
        }
        p["writable"] = true;
        p["dynamic"] = true;
        props.append(p);
    }

    return props;
}

QJsonValue InspectorServer::variantToJson(const QVariant &var)
{
    if (!var.isValid())
        return QJsonValue::Null;

    switch (var.typeId()) {
    case QMetaType::Bool:
        return var.toBool();
    case QMetaType::Int:
    case QMetaType::UInt:
    case QMetaType::Long:
    case QMetaType::ULong:
    case QMetaType::LongLong:
    case QMetaType::ULongLong:
    case QMetaType::Short:
    case QMetaType::UShort:
        return var.toLongLong();
    case QMetaType::Float:
    case QMetaType::Double:
        return var.toDouble();
    case QMetaType::QString:
        // The text of a password field, wherever it turns up (a list, a result of a call).
        if (isSecretValue(var))
            return QStringLiteral("(hidden)");
        return var.toString();
    case QMetaType::QUrl:
        return var.toUrl().toString();
    case QMetaType::QColor: {
        QColor c = var.value<QColor>();
        return c.name(QColor::HexArgb);
    }
    case QMetaType::QRect:
    case QMetaType::QRectF: {
        QRectF r = var.toRectF();
        return QJsonObject{{"x", r.x()}, {"y", r.y()},
                           {"width", r.width()}, {"height", r.height()}};
    }
    case QMetaType::QPoint:
    case QMetaType::QPointF: {
        QPointF p = var.toPointF();
        return QJsonObject{{"x", p.x()}, {"y", p.y()}};
    }
    case QMetaType::QSize:
    case QMetaType::QSizeF: {
        QSizeF s = var.toSizeF();
        return QJsonObject{{"width", s.width()}, {"height", s.height()}};
    }
    case QMetaType::QFont: {
        QFont f = var.value<QFont>();
        return QJsonObject{{"family", f.family()}, {"pointSize", f.pointSize()},
                           {"bold", f.bold()}, {"italic", f.italic()}};
    }
    case QMetaType::QStringList: {
        QJsonArray arr;
        for (const auto &s : var.toStringList())
            arr.append(isSecretValue(s) ? QStringLiteral("(hidden)") : s);
        return arr;
    }
    case QMetaType::QVariantList: {
        QJsonArray arr;
        for (const auto &v : var.toList())
            arr.append(variantToJson(v));
        return arr;
    }
    case QMetaType::QVariantMap: {
        QJsonObject obj;
        auto map = var.toMap();
        for (auto it = map.begin(); it != map.end(); ++it)
            obj[it.key()] = variantToJson(it.value());
        return obj;
    }
    default:
        // An enum is its number, as scripts compare it (checkState != 0).
        if (var.metaType().flags().testFlag(QMetaType::IsEnumeration))
            return var.toInt();
        // An object-valued property is a reference the client can follow.
        if (var.metaType().flags().testFlag(QMetaType::PointerToQObject)) {
            QObject *o = var.value<QObject*>();
            if (!o)
                return QJsonValue::Null;
            return QJsonObject{{"objectRef", registerObject(o)},
                               {"type", QString::fromUtf8(o->metaObject()->className())}};
        }
        // A value of the QML engine (a "var" property that holds a list or an object).
        if (var.userType() == qMetaTypeId<QJSValue>()) {
            const QVariant inner = var.value<QJSValue>().toVariant();
            if (inner.isValid() && inner.userType() != qMetaTypeId<QJSValue>())
                return variantToJson(inner);
        }
        // Try toString() as fallback
        if (var.canConvert<QString>()) {
            const QString text = var.toString();
            return isSecretValue(text) ? QStringLiteral("(hidden)") : text;
        }
        return QString("<%1>").arg(QString::fromUtf8(var.typeName()));
    }
}

// --- Object registry ---

QString InspectorServer::registerObject(QObject *obj)
{
    if (!obj)
        return QString();

    auto it = m_objToId.find(obj);
    if (it != m_objToId.end()) {
        // Verify the object is still alive
        if (m_idToObj[it.value()].isNull()) {
            // Object was deleted and pointer reused
            m_idToObj.remove(it.value());
            m_objToId.erase(it);
        } else {
            return it.value();
        }
    }

    QString id = QString::number(m_nextId++);
    m_idToObj[id] = obj;
    m_objToId[obj] = id;
    return id;
}

QObject* InspectorServer::resolveObject(const QString &id)
{
    auto it = m_idToObj.find(id);
    if (it == m_idToObj.end())
        return nullptr;

    if (it.value().isNull()) {
        // Object has been deleted
        QString objId = id;
        m_objToId.remove(it.value().data());
        m_idToObj.erase(it);
        return nullptr;
    }

    return it.value().data();
}

void InspectorServer::collectObjects(QObject *root)
{
    if (!root) return;
    registerObject(root);
    enqueueChildren(root, [this](QObject *child) { collectObjects(child); });
}

// --- Helpers ---

QQmlEngine* InspectorServer::findQmlEngine()
{
    for (QObject *root : rootObjects()) {
        if (auto *widget = qobject_cast<QWidget*>(root)) {
#if QMLINSPECTOR_HAVE_QUICKWIDGETS
            for (auto *qw : widget->findChildren<QQuickWidget*>()) {
                if (qw->engine())
                    return qw->engine();
            }
#else
            Q_UNUSED(widget);
#endif
            continue;
        }
        if (QQmlEngine *engine = qmlEngine(root))
            return engine;
        if (auto *win = qobject_cast<QQuickWindow*>(root)) {
            if (win->contentItem()) {
                for (QQuickItem *child : win->contentItem()->childItems()) {
                    if (QQmlEngine *engine = qmlEngine(child))
                        return engine;
                }
            }
        }
    }
    return nullptr;
}

QWidget* InspectorServer::findWidgetAt(int x, int y)
{
    QWidget *rootWidget = qobject_cast<QWidget*>(m_root.data());
    if (!rootWidget) return nullptr;
    QWidget *child = rootWidget->childAt(x, y);
    return child ? child : rootWidget;
}

bool InspectorServer::isError(const QJsonObject &obj)
{
    return obj.contains("error");
}

bool InspectorServer::isOk(const QJsonObject &obj)
{
    return obj.contains("ok");
}

QJsonObject InspectorServer::errorResult(const QString &msg)
{
    return QJsonObject{{"error", msg}};
}

QJsonObject InspectorServer::okResult(const QJsonObject &data)
{
    QJsonObject result = data;
    result["ok"] = true;
    return result;
}

QJsonArray InspectorServer::findByType(const QString &typeName, QObject *root)
{
    // Collect all objects and filter by type
    QJsonArray results;
    QSet<QObject*> visited;
    QList<QObject*> stack;
    // cost proportional to tree size, not parent-chain multiplicity.
    auto enqueue = [&](QObject *o) {
        if (o && !visited.contains(o)) {
            visited.insert(o);
            stack.append(o);
        }
    };

    enqueue(root);

    while (!stack.isEmpty()) {
        QObject *obj = stack.takeFirst();
        if (!obj) continue;

        // The class or any base class, so a QML base type finds what derives from it.
        for (const QMetaObject *mo = obj->metaObject(); mo; mo = mo->superClass()) {
            if (QString::fromUtf8(mo->className()).contains(typeName)) {
                results.append(serializeObject(obj, 0, 0));
                break;
            }
        }

        enqueueChildren(obj, enqueue);
    }

    return results;
}
