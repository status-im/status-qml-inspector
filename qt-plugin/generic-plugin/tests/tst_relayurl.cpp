#include <QtTest>

#include "relayurl.h"

class tst_RelayUrl : public QObject
{
    Q_OBJECT

private slots:
    void allowed_data()
    {
        QTest::addColumn<QString>("url");
        QTest::addColumn<bool>("expected");

        QTest::newRow("localhost") << "http://localhost:8080" << true;
        QTest::newRow("localhost, upper case") << "http://LOCALHOST:8080" << true;
        QTest::newRow("127.0.0.1") << "http://127.0.0.1:8080" << true;
        QTest::newRow("other 127/8 address") << "http://127.5.5.5:8080" << true;
        QTest::newRow("IPv6 loopback") << "http://[::1]:8080" << true;

        // The token is sent in clear text, so it must not leave the device.
        QTest::newRow("remote name") << "http://example.com:8080" << false;
        QTest::newRow("name that starts with localhost") << "http://localhost.example.com" << false;
        QTest::newRow("name that starts with 127.0.0.1") << "http://127.0.0.1.example.com" << false;
        QTest::newRow("private address") << "http://10.0.2.2:8080" << false;
        QTest::newRow("any address") << "http://0.0.0.0:8080" << false;

        QTest::newRow("https") << "https://localhost:8080" << false;
        QTest::newRow("no scheme") << "localhost:8080" << false;
        QTest::newRow("no host") << "http://" << false;
        QTest::newRow("empty") << "" << false;
    }

    void allowed()
    {
        QFETCH(QString, url);
        QFETCH(bool, expected);
        QCOMPARE(relayUrlAllowed(QUrl(url)), expected);
    }
};

QTEST_APPLESS_MAIN(tst_RelayUrl)
#include "tst_relayurl.moc"
