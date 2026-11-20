#ifndef RELAYURL_H
#define RELAYURL_H

#include <QHostAddress>
#include <QUrl>

/// Whether QML_INSPECTOR_RELAY may be used as the relay address: plain http to
/// this device only. The token goes in clear text, so the request must not
/// leave the device; a tunnel on the device carries it to the test machine.
inline bool relayUrlAllowed(const QUrl &url)
{
    if (url.scheme() != QLatin1String("http"))
        return false;
    const QString host = url.host();
    return host == QLatin1String("localhost") || QHostAddress(host).isLoopback();
}

#endif // RELAYURL_H
