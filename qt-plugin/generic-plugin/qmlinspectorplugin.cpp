// Qt generic plugin wrapper around the logos-qt-mcp InspectorServer.
//
// Loaded without touching the application source:
//   QT_PLUGIN_PATH=<dir holding generic/> QT_QPA_GENERIC_PLUGINS=qmlinspector[:<port>]
//
// What the plugin does when it is created is decided in startplan.h, from the
// environment alone:
//   - It stays off unless status-desktop's own test mode is on, that is
//     STATUS_RUNTIME_TEST_MODE is 1, true, yes or on (see envswitch.h). Then no
//     socket is opened and nothing is contacted.
//   - Desktop only: QML_INSPECTOR_ALLOW set to a true value starts it without
//     test mode, for tests of behaviour that test mode turns off. On desktop the
//     plugin is loaded only when a test points QT_PLUGIN_PATH at it. An Android
//     test build carries the plugin inside the APK, so there the variable is ignored.
//   - QML_INSPECTOR_TOKEN=<secret> has one of two uses, never both. Without
//     QML_INSPECTOR_RELAY the plugin listens, and every connection must send that
//     secret before any command (InspectorServer::setAuthToken). With
//     QML_INSPECTOR_RELAY=http://localhost:port the plugin dials out to that relay
//     instead of listening, and sends the secret in a header of each request
//     (see relayclient.h). In both uses a value that is set but empty or shorter
//     than 16 characters keeps the inspector off: it is not taken as "no token".
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
#include "startplan.h"

class QmlInspectorPlugin : public QGenericPlugin
{
    Q_OBJECT
    Q_PLUGIN_METADATA(IID QGenericPluginFactoryInterface_iid FILE "qmlinspector.json")

public:
    QObject *create(const QString &key, const QString &specification) override
    {
        if (key.compare(QLatin1String("qmlinspector"), Qt::CaseInsensitive) != 0)
            return nullptr;

        StartEnvironment env;
        for (const char *name : {"STATUS_RUNTIME_TEST_MODE", "QML_INSPECTOR_ALLOW", "QML_INSPECTOR_TOKEN",
                                 "QML_INSPECTOR_RELAY", "QML_INSPECTOR_PORT"}) {
            if (qEnvironmentVariableIsSet(name))
                env.insert(name, qgetenv(name));
        }
#ifdef Q_OS_ANDROID
        const bool android = true;
#else
        const bool android = false;
#endif
        const StartPlan plan = planStart(env, specification, android);
        if (!plan.message.isEmpty()) {
            if (plan.warning)
                qWarning().noquote() << "[QmlInspector]" << plan.message;
            else
                qInfo().noquote() << "[QmlInspector]" << plan.message;
        }
        if (plan.mode == StartPlan::Off)
            return nullptr;

        auto *inspector = new InspectorServer;
        inspector->setRootObject(nullptr);
        if (plan.mode == StartPlan::Relay) {
            // Not started: in dial-out mode nothing listens.
            (new InspectorRelayClient(inspector, plan.relay, plan.token, inspector))->start();
            return inspector;
        }
        inspector->setAuthToken(plan.token);
        inspector->start(plan.port);
        return inspector;
    }
};

#include "qmlinspectorplugin.moc"
