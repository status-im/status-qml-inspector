// Qt generic plugin wrapper around the logos-qt-mcp InspectorServer.
//
// Loaded without touching the application source:
//   QT_PLUGIN_PATH=<dir holding generic/> QT_QPA_GENERIC_PLUGINS=qmlinspector[:<port>]
//
// The inspector is only started when status-desktop's own test mode is on,
// i.e. STATUS_RUNTIME_TEST_MODE is set to a true value. With it unset the
// plugin returns nothing, so no socket is ever opened and nothing is contacted.
//
// With QML_INSPECTOR_RELAY=http://host:port and QML_INSPECTOR_TOKEN=<secret>
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

static bool statusTestModeOn()
{
    const QByteArray value = qgetenv("STATUS_RUNTIME_TEST_MODE").trimmed().toLower();
    return !(value.isEmpty() || value == "0" || value == "false" || value == "no" || value == "off");
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

        if (!statusTestModeOn()) {
            qInfo("[QmlInspector] STATUS_RUNTIME_TEST_MODE is not set; inspector stays off");
            return nullptr;
        }

        const QByteArray relay = qgetenv("QML_INSPECTOR_RELAY").trimmed();
        if (!relay.isEmpty()) {
            const QUrl url(QString::fromUtf8(relay));
            const QByteArray token = qgetenv("QML_INSPECTOR_TOKEN").trimmed();
            if (token.isEmpty() || url.scheme() != QLatin1String("http") || url.host().isEmpty()) {
                qWarning("[QmlInspector] QML_INSPECTOR_RELAY needs an http URL and "
                         "QML_INSPECTOR_TOKEN; inspector stays off");
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
