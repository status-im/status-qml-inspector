#ifndef QMLINSPECTOR_STARTPLAN_H
#define QMLINSPECTOR_STARTPLAN_H

#include <QByteArray>
#include <QHash>
#include <QString>
#include <QUrl>

#include "envswitch.h"
#include "relayurl.h"
#include "tokenrule.h"

// What the plugin does when it is created, decided from the environment alone. It is a function of its own,
// with no Qt GUI in it, so that every branch has a test (tests/tst_startplan.cpp).
struct StartPlan
{
    enum Mode { Off, Listen, Relay };
    Mode mode = Off;
    QString message;       // for the log: why the inspector stays off, or what the user should know
    bool warning = false;  // the message is a warning
    QByteArray token;      // Listen: the token every connection must send, empty for none. Relay: the token for the relay.
    int port = 0;          // Listen
    QUrl relay;            // Relay
};

/// The environment: only the variables that are set are in it.
using StartEnvironment = QHash<QByteArray, QByteArray>;

/// `specification` is what follows "qmlinspector:" in QT_QPA_GENERIC_PLUGINS (a port, or nothing).
/// `android`: an Android build carries the plugin inside the APK, so there only the test mode of the app turns it on.
inline StartPlan planStart(const StartEnvironment &env, const QString &specification, bool android)
{
    StartPlan plan;
    const auto off = [&plan](const QString &message, bool warning) {
        plan.mode = StartPlan::Off;
        plan.message = message;
        plan.warning = warning;
        plan.token.clear();
        return plan;
    };

    const bool testMode = switchIsOn(env.value("STATUS_RUNTIME_TEST_MODE"));
    if (!testMode && (android || !switchIsOn(env.value("QML_INSPECTOR_ALLOW")))) {
        return off(android
                       ? QStringLiteral("STATUS_RUNTIME_TEST_MODE is not 1, true, yes or on; inspector stays off")
                       : QStringLiteral("Neither STATUS_RUNTIME_TEST_MODE nor QML_INSPECTOR_ALLOW is 1, true, yes or on; inspector stays off"),
                   false);
    }

    const bool tokenSet = env.contains("QML_INSPECTOR_TOKEN");
    const QByteArray token = env.value("QML_INSPECTOR_TOKEN").trimmed();
    const QString tokenProblem = InspectorToken::problem(token);

    const QByteArray relay = env.value("QML_INSPECTOR_RELAY").trimmed();
    if (!relay.isEmpty()) {
        const QUrl url(QString::fromUtf8(relay));
        if (!relayUrlAllowed(url))
            return off(QStringLiteral("QML_INSPECTOR_RELAY must be an http URL on localhost; inspector stays off"), true);
        // The same rule as for a listening server: a short token is not a token.
        if (!tokenProblem.isEmpty())
            return off(QStringLiteral("QML_INSPECTOR_RELAY needs QML_INSPECTOR_TOKEN, and %1; inspector stays off").arg(tokenProblem), true);
        plan.mode = StartPlan::Relay;
        plan.relay = url;
        plan.token = token;
        return plan;
    }

    // A value that is set but cannot be used keeps the inspector off: it is never taken as "no token".
    if (tokenSet && !tokenProblem.isEmpty())
        return off(QStringLiteral("QML_INSPECTOR_TOKEN is set but cannot be used: %1; inspector stays off").arg(tokenProblem), true);

    bool ok = false;
    int port = specification.toInt(&ok);
    if (!ok)
        port = env.value("QML_INSPECTOR_PORT").trimmed().toInt(&ok);
    plan.port = ok ? port : 3768;
    plan.mode = StartPlan::Listen;
    plan.token = token;
    if (!tokenSet) {
        plan.message = QStringLiteral("No QML_INSPECTOR_TOKEN: every program on this device can send commands");
        plan.warning = true;
    }
    return plan;
}

#endif // QMLINSPECTOR_STARTPLAN_H
