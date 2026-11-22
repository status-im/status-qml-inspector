// What the plugin does when it is created: off, listen (with or without a token), or dial out to a relay.
#include <QtTest>

#include "startplan.h"

// 18 characters: no token shorter than 16 is taken.
#define TOKEN "s3cret-of-16-chars"

class tst_StartPlan : public QObject
{
    Q_OBJECT

private:
    static StartEnvironment testMode(StartEnvironment more = {})
    {
        more.insert("STATUS_RUNTIME_TEST_MODE", "1");
        return more;
    }

private slots:
    void withoutASwitch_itStaysOff()
    {
        QCOMPARE(planStart({}, "", false).mode, StartPlan::Off);
        QCOMPARE(planStart({{"STATUS_RUNTIME_TEST_MODE", "0"}}, "", false).mode, StartPlan::Off);
        QCOMPARE(planStart({{"STATUS_RUNTIME_TEST_MODE", "enabled"}}, "", false).mode, StartPlan::Off);
        // A token alone turns nothing on.
        QCOMPARE(planStart({{"QML_INSPECTOR_TOKEN", TOKEN}}, "", false).mode, StartPlan::Off);
    }

    void theMessageNamesTheSwitchesThatCount()
    {
        // On desktop two switches can turn it on, and the message names both.
        const QString desktop = planStart({}, "", false).message;
        QVERIFY2(desktop.contains("STATUS_RUNTIME_TEST_MODE") && desktop.contains("QML_INSPECTOR_ALLOW"), qPrintable(desktop));
        const QString android = planStart({{"QML_INSPECTOR_ALLOW", "1"}}, "", true).message;
        QVERIFY2(android.contains("STATUS_RUNTIME_TEST_MODE") && !android.contains("QML_INSPECTOR_ALLOW"), qPrintable(android));
    }

    void allowSwitch_countsOnDesktopOnly()
    {
        QCOMPARE(planStart({{"QML_INSPECTOR_ALLOW", "1"}}, "", false).mode, StartPlan::Listen);
        QCOMPARE(planStart({{"QML_INSPECTOR_ALLOW", "1"}}, "", true).mode, StartPlan::Off);
        QCOMPARE(planStart({{"QML_INSPECTOR_ALLOW", "1"}, {"QML_INSPECTOR_TOKEN", TOKEN}}, "", true).mode, StartPlan::Off);
        QCOMPARE(planStart(testMode(), "", true).mode, StartPlan::Listen);
    }

    void withoutAToken_itListensAndWarns()
    {
        const StartPlan plan = planStart(testMode(), "", false);
        QCOMPARE(plan.mode, StartPlan::Listen);
        QVERIFY(plan.token.isEmpty());
        QVERIFY(plan.warning);
        QVERIFY(plan.message.contains("every program"));
    }

    void token_isTrimmedAndUsed()
    {
        const StartPlan plan = planStart(testMode({{"QML_INSPECTOR_TOKEN", "  " TOKEN "\n"}}), "", false);
        QCOMPARE(plan.mode, StartPlan::Listen);
        QCOMPARE(plan.token, QByteArray(TOKEN));
        QVERIFY(plan.message.isEmpty());
    }

    void tokenThatCannotBeUsed_keepsItOff_data()
    {
        QTest::addColumn<QByteArray>("value");
        QTest::newRow("empty") << QByteArray("");
        QTest::newRow("spaces only") << QByteArray("                    ");
        QTest::newRow("short") << QByteArray("short");
        QTest::newRow("15 characters") << QByteArray("123456789012345");
        QTest::newRow("16 with spaces around 14") << QByteArray(" 12345678901234 ");
    }
    void tokenThatCannotBeUsed_keepsItOff()
    {
        QFETCH(QByteArray, value);
        const StartPlan plan = planStart(testMode({{"QML_INSPECTOR_TOKEN", value}}), "", false);
        QCOMPARE(plan.mode, StartPlan::Off);
        QVERIFY(plan.warning);
        QVERIFY(plan.token.isEmpty());
        // The message never repeats the value.
        if (!value.trimmed().isEmpty())
            QVERIFY(!plan.message.contains(QString::fromUtf8(value.trimmed())));
    }

    void sixteenCharacters_areEnough()
    {
        QCOMPARE(planStart(testMode({{"QML_INSPECTOR_TOKEN", "1234567890123456"}}), "", false).mode, StartPlan::Listen);
    }

    void port_fromTheSpecificationThenTheVariableThenTheDefault()
    {
        QCOMPARE(planStart(testMode(), "", false).port, 3768);
        QCOMPARE(planStart(testMode({{"QML_INSPECTOR_PORT", "4000"}}), "", false).port, 4000);
        QCOMPARE(planStart(testMode({{"QML_INSPECTOR_PORT", "4000"}}), "4100", false).port, 4100);
        QCOMPARE(planStart(testMode({{"QML_INSPECTOR_PORT", "abc"}}), "", false).port, 3768);
    }

    void relay_needsALocalAddressAndATokenOfFullLength()
    {
        const auto relay = [](const QByteArray &url, const QByteArray &token, bool tokenSet = true) {
            StartEnvironment env{{"STATUS_RUNTIME_TEST_MODE", "1"}, {"QML_INSPECTOR_RELAY", url}};
            if (tokenSet)
                env.insert("QML_INSPECTOR_TOKEN", token);
            return planStart(env, "", true);
        };
        const StartPlan good = relay("http://localhost:8123", " " TOKEN " ");
        QCOMPARE(good.mode, StartPlan::Relay);
        QCOMPARE(good.token, QByteArray(TOKEN));
        QCOMPARE(good.relay, QUrl("http://localhost:8123"));
        // The same rule as for a listening server: no token, an empty one or a short one keeps it off.
        QCOMPARE(relay("http://localhost:8123", "", false).mode, StartPlan::Off);
        QCOMPARE(relay("http://localhost:8123", "").mode, StartPlan::Off);
        QCOMPARE(relay("http://localhost:8123", "x").mode, StartPlan::Off);
        QCOMPARE(relay("http://localhost:8123", "123456789012345").mode, StartPlan::Off);
        // Another host, or https, keeps it off: it does not fall back to listening.
        QCOMPARE(relay("http://example.com:8123", TOKEN).mode, StartPlan::Off);
        QCOMPARE(relay("https://localhost:8123", TOKEN).mode, StartPlan::Off);
        // Without test mode the relay is not used either.
        QCOMPARE(planStart({{"QML_INSPECTOR_RELAY", "http://localhost:8123"}, {"QML_INSPECTOR_TOKEN", TOKEN}}, "", true).mode, StartPlan::Off);
    }
};

QTEST_APPLESS_MAIN(tst_StartPlan)
#include "tst_startplan.moc"
