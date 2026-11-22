#ifndef QMLINSPECTOR_ENVSWITCH_H
#define QMLINSPECTOR_ENVSWITCH_H

#include <QByteArray>

// A switch from the environment is on with 1, true, yes or on (any case, spaces around it do not count).
// Every other value, and no value, is off: a value that is not known never turns something on.
// A client of the plugin that has switches of its own should read them by the same rule.
inline bool switchIsOn(const QByteArray &raw)
{
    const QByteArray value = raw.trimmed().toLower();
    return value == "1" || value == "true" || value == "yes" || value == "on";
}

#endif // QMLINSPECTOR_ENVSWITCH_H
