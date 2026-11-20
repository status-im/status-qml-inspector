#ifndef RELAYCLIENT_H
#define RELAYCLIENT_H

#include <QByteArray>
#include <QNetworkAccessManager>
#include <QNetworkRequest>
#include <QObject>
#include <QUrl>

class InspectorServer;
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

    /// The only commands answered through a relay. The channel leaves the
    /// device, so it reads state and never changes it.
    static bool isReadCommand(const QString &command);

private:
    void poll();
    void onNextFinished(QNetworkReply *reply);
    void postReply(const QByteArray &body);
    void retryLater();
    QNetworkRequest request(const QString &path, int timeoutMs) const;
    void useSystemProxy();

    InspectorServer *m_inspector;
    QUrl m_relay;
    QByteArray m_token;
    QNetworkAccessManager m_network;
    bool m_reached = false;
    bool m_failing = false;
};

#endif // RELAYCLIENT_H
