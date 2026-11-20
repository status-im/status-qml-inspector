#include "relayclient.h"

#include "inspectorserver.h"

#include <QDebug>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkProxy>
#include <QNetworkProxyFactory>
#include <QNetworkProxyQuery>
#include <QNetworkReply>
#include <QTimer>

namespace {
const char TokenHeader[] = "X-Inspector-Token";
// The relay answers a poll within about 10 seconds, with a request or with
// 204. A farm's tunnel cuts a request left open much longer.
const int PollTimeoutMs = 30000;
const int ReplyTimeoutMs = 30000;
const int RetryDelayMs = 2000;
}

InspectorRelayClient::InspectorRelayClient(InspectorServer *inspector, const QUrl &relay,
                                           const QByteArray &token, QObject *parent)
    : QObject(parent)
    , m_inspector(inspector)
    , m_relay(relay)
    , m_token(token)
{
}

bool InspectorRelayClient::isReadCommand(const QString &command)
{
    return command == QLatin1String("getTree")
        || command == QLatin1String("getProperties")
        || command == QLatin1String("findByType")
        || command == QLatin1String("findByProperty");
}

void InspectorRelayClient::start()
{
    qInfo().noquote() << "[QmlInspector] Dial-out to relay" << m_relay.toString()
                      << "(read commands only; nothing listens on this device)";
    // The plugin is created inside the application's constructor: wait for
    // the event loop before the first request.
    QTimer::singleShot(0, this, &InspectorRelayClient::poll);
}

void InspectorRelayClient::useSystemProxy()
{
    // Qt does not use the system proxy unless asked. On a farm phone the
    // proxy is the only route to the relay; with none set this connects
    // directly. The manager is the plugin's own, so the app is unaffected.
    const QList<QNetworkProxy> proxies =
        QNetworkProxyFactory::systemProxyForQuery(QNetworkProxyQuery(m_relay));
    m_network.setProxy(proxies.isEmpty() ? QNetworkProxy(QNetworkProxy::NoProxy)
                                         : proxies.first());
}

QNetworkRequest InspectorRelayClient::request(const QString &path, int timeoutMs) const
{
    QUrl url = m_relay;
    url.setPath(path);
    QNetworkRequest request(url);
    request.setRawHeader(TokenHeader, m_token);
    request.setTransferTimeout(timeoutMs);
    // Qt follows redirects by default and sends the headers again. The relay
    // never redirects, so one is not followed and the secret goes nowhere else.
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                         QNetworkRequest::ManualRedirectPolicy);
    return request;
}

void InspectorRelayClient::poll()
{
    useSystemProxy();
    QNetworkReply *reply = m_network.get(request(QStringLiteral("/next"), PollTimeoutMs));
    connect(reply, &QNetworkReply::finished, this, [this, reply]() { onNextFinished(reply); });
}

void InspectorRelayClient::onNextFinished(QNetworkReply *reply)
{
    reply->deleteLater();
    const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();

    if (reply->error() != QNetworkReply::NoError || (status != 200 && status != 204)) {
        if (!m_failing) {
            qWarning().noquote() << "[QmlInspector] Relay poll failed (status" << status << "):"
                                 << reply->errorString() << "- retrying";
            m_failing = true;
        }
        retryLater();
        return;
    }
    m_failing = false;
    if (!m_reached) {
        qInfo("[QmlInspector] Relay reached");
        m_reached = true;
    }

    if (status == 204) {
        poll();
        return;
    }

    const QJsonObject command = QJsonDocument::fromJson(reply->readAll()).object();
    const QString name = command.value(QStringLiteral("command")).toString();
    QJsonObject result;
    if (isReadCommand(name)) {
        result = m_inspector->handleCommand(command);
    } else {
        result = QJsonObject{{QStringLiteral("error"),
                              QStringLiteral("Not available through a relay: %1").arg(name)}};
        if (command.contains(QStringLiteral("id")))
            result[QStringLiteral("id")] = command.value(QStringLiteral("id"));
    }
    postReply(QJsonDocument(result).toJson(QJsonDocument::Compact));
}

void InspectorRelayClient::postReply(const QByteArray &body)
{
    QNetworkRequest post = request(QStringLiteral("/reply"), ReplyTimeoutMs);
    post.setHeader(QNetworkRequest::ContentTypeHeader, QByteArrayLiteral("application/json"));
    QNetworkReply *reply = m_network.post(post, body);
    connect(reply, &QNetworkReply::finished, this, [this, reply]() {
        reply->deleteLater();
        if (reply->error() != QNetworkReply::NoError) {
            // The test's read times out and reports it; keep serving.
            qWarning().noquote() << "[QmlInspector] Reply was not delivered:"
                                 << reply->errorString();
            retryLater();
            return;
        }
        poll();
    });
}

void InspectorRelayClient::retryLater()
{
    QTimer::singleShot(RetryDelayMs, this, &InspectorRelayClient::poll);
}
