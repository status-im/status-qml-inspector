#ifndef RELAYCLIENT_H
#define RELAYCLIENT_H

#include <QByteArray>
#include <QNetworkAccessManager>
#include <QNetworkRequest>
#include <QObject>
#include <QUrl>

#include "inspectorserver.h"

class QNetworkReply;

/// Dial-out: serves the inspector's read commands to a relay the app connects
/// to, for devices nothing can connect to (a device farm).
///
/// The app asks the relay for the next request (GET /next), runs it, posts
/// the reply (POST /reply) and asks again. Requests and replies are the
/// inspector's own JSON objects. Every call carries the session's secret.
class InspectorRelayClient : public QObject
{
    Q_OBJECT

public:
    InspectorRelayClient(InspectorServer *inspector, const QUrl &relay,
                         const QByteArray &token, QObject *parent = nullptr);
    void start();

    /// The only commands of the app answered through a relay. The channel leaves the
    /// device, so it reads state and never changes it. ("hideSecrets" is answered too: it changes
    /// only what the replies hold.)
    static bool isReadCommand(const QString &command);

    /// Runs one request of the relay and returns the reply to post. Public for the tests.
    QJsonObject run(const QJsonObject &command);

private:
    void poll();
    void onNextFinished(QNetworkReply *reply);
    void postReply(const QByteArray &body);
    void retryLater();
    QNetworkRequest request(const QString &path, int timeoutMs) const;
    void useSystemProxy();

    InspectorServer *m_inspector;
    // The relay is one client. What it has asked for holds until the app exits: the plugin cannot see when
    // the test on the other side of the relay ends.
    InspectorServer::Session m_session;
    QUrl m_relay;
    QByteArray m_token;
    QNetworkAccessManager m_network;
    bool m_reached = false;
    bool m_failing = false;
};

#endif // RELAYCLIENT_H
