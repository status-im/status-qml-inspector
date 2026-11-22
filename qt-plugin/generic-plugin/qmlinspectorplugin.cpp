// Qt generic plugin wrapper around the logos-qt-mcp InspectorServer.
//
// Loaded without touching the application source:
//   QT_PLUGIN_PATH=<dir holding generic/> QT_QPA_GENERIC_PLUGINS=qmlinspector[:<port>]
//
// The inspector is only started when status-desktop's own test mode is on,
// i.e. STATUS_RUNTIME_TEST_MODE is set to a true value: 1, true, yes or on
// (see envswitch.h). With it unset, or set to anything else, the plugin
// returns nothing, so no socket is ever opened and nothing is contacted.
//
// Desktop only: QML_INSPECTOR_ALLOW set to a true value starts it without test
// mode, for tests of behaviour that test mode turns off. On desktop the plugin
// is loaded only when a test points QT_PLUGIN_PATH at it. An Android test build
// carries the plugin inside the APK, so there the variable is ignored.
//
// QML_INSPECTOR_TOKEN=<secret> has one of two uses, never both:
//   - Without QML_INSPECTOR_RELAY the plugin listens, and every connection must
//     send that secret before any command (InspectorServer::setAuthToken).
//     A value that is set but empty or shorter than 16 characters keeps the
//     inspector off: it is not taken as "no token".
//   - With QML_INSPECTOR_RELAY=http://localhost:port the plugin dials out to that
//     relay instead of listening, and sends the secret in a header of each
//     request, so that the relay knows the plugin (see relayclient.h).
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
#include "envswitch.h"

static bool envIsTrue(const char *name)
{
    return switchIsOn(qgetenv(name));
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
            qInfo("[QmlInspector] STATUS_RUNTIME_TEST_MODE is not 1, true, yes or on; inspector stays off");
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
        int port = specification.toInt(&ok);
        if (!ok) {
            port = qEnvironmentVariableIntValue("QML_INSPECTOR_PORT", &ok);
            if (!ok)
                port = 3768;
        }

        auto *inspector = new InspectorServer;
        inspector->setRootObject(nullptr);
        if (qEnvironmentVariableIsSet("QML_INSPECTOR_TOKEN")) {
            const QByteArray token = qgetenv("QML_INSPECTOR_TOKEN").trimmed();
            const QString problem = InspectorServer::tokenProblem(token);
            if (!problem.isEmpty()) {
                qWarning().noquote() << "[QmlInspector] QML_INSPECTOR_TOKEN is set but cannot be used:"
                                     << problem << "- inspector stays off";
                delete inspector;
                return nullptr;
            }
            inspector->setAuthToken(token);
        } else {
            qWarning("[QmlInspector] No QML_INSPECTOR_TOKEN: every program on this device can send commands");
        }
        inspector->start(port);
        return inspector;
    }
};

#include "qmlinspectorplugin.moc"
