#ifndef QMLINSPECTOR_TOKENRULE_H
#define QMLINSPECTOR_TOKENRULE_H

#include <QByteArray>
#include <QString>

// The one rule for a token, for the listening server, for attach() and for the dial-out mode of the plugin.
namespace InspectorToken {

/// The shortest token that is accepted.
constexpr int kMinLength = 16;

/// Why a value cannot be used as a token (too short), or an empty string when it can.
inline QString problem(const QByteArray &token)
{
    if (token.size() < kMinLength)
        return QStringLiteral("the token must have at least %1 characters").arg(kMinLength);
    return QString();
}

} // namespace InspectorToken

#endif // QMLINSPECTOR_TOKENRULE_H
