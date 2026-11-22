// Which values of an environment variable turn a switch on.
#include <QtTest>

#include "envswitch.h"

class tst_EnvSwitch : public QObject
{
    Q_OBJECT

private slots:
    void onlyTheFourWordsAreOn_data()
    {
        QTest::addColumn<QByteArray>("value");
        QTest::addColumn<bool>("on");
        for (const char *value : {"1", "true", "TRUE", "True", "yes", "Yes", "on", "ON", " 1 ", "true\n"})
            QTest::newRow(value) << QByteArray(value) << true;
        // Everything else is off, also a value that looks like "on" to a person: the MCP server reads it as off too.
        for (const char *value : {"", " ", "0", "false", "no", "off", "2", "enabled", "y", "t", "si", "01", "-1", "true1", "on off"})
            QTest::newRow(*value ? value : "(empty)") << QByteArray(value) << false;
    }
    void onlyTheFourWordsAreOn()
    {
        QFETCH(QByteArray, value);
        QFETCH(bool, on);
        QCOMPARE(switchIsOn(value), on);
    }
};

QTEST_APPLESS_MAIN(tst_EnvSwitch)
#include "tst_envswitch.moc"
