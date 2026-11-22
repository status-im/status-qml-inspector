#ifndef QMLINSPECTOR_ENVSWITCH_H
#define QMLINSPECTOR_ENVSWITCH_H

#include <QByteArray>

// A switch from the environment is on with 1, true, yes or on (any case, spaces around it do not count).
// Every other value, and no value, is off. The MCP server reads its switches by the same rule (index.mjs, isOn),
// so a value that one side does not know never turns something on.
inline bool switchIsOn(const QByteArray &raw)
{
    const QByteArray value = raw.trimmed().toLower();
    return value == "1" || value == "true" || value == "yes" || value == "on";
}

#endif // QMLINSPECTOR_ENVSWITCH_H
