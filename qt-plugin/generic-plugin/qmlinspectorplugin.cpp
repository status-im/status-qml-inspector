// Qt generic plugin wrapper around the logos-qt-mcp InspectorServer.
//
// Loaded without touching the application source:
//   QT_PLUGIN_PATH=<dir holding generic/> QT_QPA_GENERIC_PLUGINS=qmlinspector[:<port>]
//
// The inspector is only started when status-desktop's own test mode is on,
// i.e. STATUS_RUNTIME_TEST_MODE is set to a true value. With it unset the
// plugin returns nothing, so no socket is ever opened and nothing is contacted.
//
// Desktop only: QML_INSPECTOR_ALLOW set to a true value starts it without test
// mode, for tests of behaviour that test mode turns off. On desktop the plugin
// is loaded only when a test points QT_PLUGIN_PATH at it. An Android test build
// carries the plugin inside the APK, so there the variable is ignored.
//
// With QML_INSPECTOR_RELAY=http://localhost:port and QML_INSPECTOR_TOKEN=<secret>
// the plugin dials out to that relay instead of listening (see relayclient.h).
// It never does both.
//
// Generic plugins are created inside the QGuiApplication constructor, before
// any window or QML engine exists; the server therefore starts with no root
// and resolves QGuiApplication::topLevelWindows() on every command.

#include <QGenericPlugin>
#include <QByteArray>
#include <QString>
#include <QDebug>
#include <QUrl>

#include "inspectorserver.h"
#include "relayclient.h"
#include "relayurl.h"

static bool envIsTrue(const char *name)
{
    const QByteArray value = qgetenv(name).trimmed().toLower();
    return !(value.isEmpty() || value == "0" || value == "false" || value == "no" || value == "off");
}

static bool allowedToStart()
{
    if (envIsTrue("STATUS_RUNTIME_TEST_MODE"))
        return true;
#ifdef Q_OS_ANDROID
    return false;
#else
    return envIsTrue("QML_INSPECTOR_ALLOW");
#endif
}

class QmlInspectorPlugin : public QGenericPlugin
{
    Q_OBJECT
    Q_PLUGIN_METADATA(IID QGenericPluginFactoryInterface_iid FILE "qmlinspector.json")

public:
    QObject *create(const QString &key, const QString &specification) override
    {
        if (key.compare(QLatin1String("qmlinspector"), Qt::CaseInsensitive) != 0)
            return nullptr;

        if (!allowedToStart()) {
            qInfo("[QmlInspector] STATUS_RUNTIME_TEST_MODE is not set; inspector stays off");
            return nullptr;
        }

        const QByteArray relay = qgetenv("QML_INSPECTOR_RELAY").trimmed();
        if (!relay.isEmpty()) {
            const QUrl url(QString::fromUtf8(relay));
            const QByteArray token = qgetenv("QML_INSPECTOR_TOKEN").trimmed();
            if (token.isEmpty() || !relayUrlAllowed(url)) {
                qWarning("[QmlInspector] QML_INSPECTOR_RELAY needs an http URL on localhost "
                         "and QML_INSPECTOR_TOKEN; inspector stays off");
                return nullptr;
            }
            // Not started: in dial-out mode nothing listens.
            auto *inspector = new InspectorServer;
            inspector->setRootObject(nullptr);
            (new InspectorRelayClient(inspector, url, token, inspector))->start();
            return inspector;
        }

        bool ok = false;
        const int port = specification.toInt(&ok);
        return InspectorServer::attach(nullptr, ok ? port : 0);
    }
};

#include "qmlinspectorplugin.moc"
