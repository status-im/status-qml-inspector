// What a password field holds must not be in any reply of the server.
#include <QtTest>
#include <QGuiApplication>
#include <QQmlEngine>
#include <QQmlComponent>
#include <QQuickItem>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>

#include "inspectorserver.h"

static const char *kSecret = "hunter2-Secret!";

// Counts how often its properties are read.
class Counted : public QObject
{
    Q_OBJECT
    Q_PROPERTY(int cheap READ cheap CONSTANT)
    Q_PROPERTY(int costly READ costly CONSTANT)
public:
    int cheap() const { ++cheapReads; return 1; }
    int costly() const { ++costlyReads; return 2; }
    mutable int cheapReads = 0;
    mutable int costlyReads = 0;
};

class tst_Secrets : public QObject
{
    Q_OBJECT

private:
    QQmlEngine m_engine;
    std::unique_ptr<QObject> m_root;
    InspectorServer m_server;
    int m_id = 0;

    QJsonObject ask(const QString &command, const QJsonObject &params = {})
    {
        return m_server.handleCommand(QJsonObject{{"id", ++m_id}, {"command", command}, {"params", params}});
    }
    static QByteArray text(const QJsonObject &reply) { return QJsonDocument(reply).toJson(); }
    QString idOf(const QString &objectName)
    {
        const QJsonArray matches = ask("findByProperty", {{"property", "objectName"}, {"value", objectName}}).value("matches").toArray();
        return matches.isEmpty() ? QString() : matches.first().toObject().value("id").toString();
    }
    QJsonObject property(const QString &objectName, const QString &name)
    {
        const QJsonArray props = ask("getProperties", {{"objectId", idOf(objectName)}}).value("properties").toArray();
        for (const QJsonValue &p : props)
            if (p.toObject().value("name").toString() == name)
                return p.toObject();
        return {};
    }

private slots:
    void initTestCase()
    {
        QQmlComponent component(&m_engine);
        component.setData(R"(
            import QtQuick
            import QtQuick.Controls
            import QtQuick.Dialogs
            Item {
                objectName: "root"
                // A wrapper that repeats the text of its field, as input controls often do.
                Item {
                    objectName: "wrapper"
                    property alias text: password.text
                    property string label: "Password"
                    TextInput { id: password; objectName: "password"; echoMode: TextInput.Password; text: "hunter2-Secret!" }
                }
                TextInput { objectName: "noEcho"; echoMode: TextInput.NoEcho; text: "other-Secret-9" }
                TextInput { objectName: "plain"; text: "visible text" }
                TextInput { objectName: "emptyPassword"; echoMode: TextInput.Password }
                Text { objectName: "copy"; property var parts: ["a", "hunter2-Secret!"] }
                Item { objectName: "on"; property bool checked: true }
                Item { objectName: "off"; property bool checked: false }
                Item { objectName: "hiddenOn"; visible: false; property bool checked: true }
                Popup { objectName: "dialog"; modal: true; Text { objectName: "insideClosedDialog"; text: "in the dialog" } }
                Drawer { objectName: "drawer"; Text { objectName: "insideClosedDrawer"; text: "in the drawer" } }
                FileDialog { objectName: "fileDialog"; title: "hunter2-Secret!" }
                Item { objectName: "lists" }
            }
        )", QUrl());
        m_root.reset(component.create());
        QVERIFY2(m_root, qPrintable(component.errorString()));
        m_server.setRootObject(m_root.get());
        // Values that hold the text inside them, in the forms a C++ property can have.
        QObject *lists = m_root->findChild<QObject*>("lists");
        QVERIFY(lists);
        lists->setProperty("names", QStringList{"first", kSecret});
        lists->setProperty("mixed", QVariantList{1, QString(kSecret), QVariantMap{{"inner", QString(kSecret)}}});
        lists->setProperty("bytes", QByteArray(kSecret));
        lists->setProperty("plainNames", QStringList{"first", "second"});
    }

    void lists_hideTheTextInsideThem()
    {
        const QJsonObject reply = ask("getProperties", {{"objectId", idOf("lists")}});
        QVERIFY(reply.value("ok").toBool());
        QVERIFY2(!text(reply).contains(kSecret), text(reply).constData());
        // The other entries stay.
        QCOMPARE(property("lists", "names").value("value").toArray(), QJsonArray({"first", "(hidden)"}));
        QCOMPARE(property("lists", "plainNames").value("value").toArray(), QJsonArray({"first", "second"}));
        for (const char *name : {"names", "mixed", "bytes"}) {
            const QJsonObject found = ask("findByProperty", {{"property", name}});
            QCOMPARE(found.value("count").toInt(), 1);
            QVERIFY2(!text(found).contains(kSecret), name);
        }
        // A search by value does not say that a list with the text is right.
        QCOMPARE(ask("findByProperty", {{"property", "names"}, {"value", QJsonArray{"first", kSecret}}}).value("count").toInt(), 0);
        QCOMPARE(ask("findByProperty", {{"property", "bytes"}, {"value", kSecret}}).value("count").toInt(), 0);
        QCOMPARE(ask("findByProperty", {{"property", "plainNames"}, {"value", QJsonArray{"first", "second"}}}).value("count").toInt(), 1);
    }

    void fileDialogs_hideTheText_alsoRightAfterItChanged()
    {
        const QJsonObject reply = ask("listFileDialogs");
        QVERIFY(reply.value("ok").toBool());
        QVERIFY(reply.value("dialogs").toArray().size() >= 1);
        QVERIFY(text(reply).contains("\"fileDialog\""));
        QVERIFY2(!text(reply).contains(kSecret), text(reply).constData());
        QVERIFY(reply.value("secretsHidden").toBool());
        // The texts are looked up for each command: a password typed since the last one is hidden too.
        QObject *dialog = m_root->findChild<QObject*>("fileDialog");
        QObject *field = m_root->findChild<QObject*>("emptyPassword");
        QVERIFY(dialog && field);
        dialog->setProperty("title", "typed-just-Now-1");
        field->setProperty("text", "typed-just-Now-1");
        QVERIFY(!text(ask("listFileDialogs")).contains("typed-just-Now-1"));
        field->setProperty("text", "");
        QVERIFY(text(ask("listFileDialogs")).contains("typed-just-Now-1"));
        dialog->setProperty("title", kSecret);
    }

    void callMethod_andSetProperty_sendNoPasswordText()
    {
        const QJsonObject called = ask("callMethod", {{"objectId", idOf("password")}, {"method", "selectAll"}, {"args", QJsonArray()}});
        QVERIFY2(called.value("ok").toBool(), text(called).constData());
        QVERIFY(!text(called).contains(kSecret));
        QVERIFY(called.value("secretsHidden").toBool());
        // setProperty reads the value back: a property that mirrors the field must not come back as text.
        const QJsonObject set = ask("setProperty", {{"objectId", idOf("wrapper")}, {"property", "label"}, {"value", kSecret}});
        QVERIFY(set.value("ok").toBool());
        QVERIFY2(!text(set).contains(kSecret), text(set).constData());
        QVERIFY(set.value("secretsHidden").toBool());
        QVERIFY(ask("setProperty", {{"objectId", idOf("wrapper")}, {"property", "label"}, {"value", "Password"}}).value("ok").toBool());
    }

    // The content of a closed dialog is not sent with every tree. A closed drawer is: a click can open it.
    void tree_leavesOutTheContentOfClosedPopups_exceptADrawer()
    {
        const QJsonObject whole = ask("getTree", {{"depth", 30}});
        QVERIFY(text(whole).contains("\"dialog\""));
        QVERIFY(!text(whole).contains("insideClosedDialog"));
        QVERIFY(text(whole).contains("insideClosedDrawer"));
        // The content of the dialog can still be read by asking for the dialog.
        const QJsonObject dialog = ask("getTree", {{"objectId", idOf("dialog")}, {"depth", 30}});
        QVERIFY(text(dialog).contains("insideClosedDialog"));
    }

    void tree_hasNoPasswordText()
    {
        const QJsonObject reply = ask("getTree", {{"depth", 20}});
        QVERIFY(reply.value("ok").toBool());
        QVERIFY(!text(reply).contains(kSecret));
        QVERIFY(!text(reply).contains("other-Secret-9"));
        // The text of a field that shows it is still there.
        QVERIFY(text(reply).contains("visible text"));
        QVERIFY(reply.value("secretsHidden").toBool());
    }

    void tree_marksTheFieldAndGivesItsLength()
    {
        const QJsonObject node = ask("getTree", {{"objectId", idOf("password")}, {"depth", 0}}).value("tree").toObject();
        QCOMPARE(node.value("secret").toBool(), true);
        QCOMPARE(node.value("textLength").toInt(), int(strlen(kSecret)));
        QCOMPARE(node.value("echoMode").toInt(), 2);
        QVERIFY(!node.contains("text"));
        const QJsonObject plain = ask("getTree", {{"objectId", idOf("plain")}, {"depth", 0}}).value("tree").toObject();
        QCOMPARE(plain.value("text").toString(), QString("visible text"));
        QCOMPARE(plain.value("echoMode").toInt(), 0);
        QVERIFY(!plain.contains("secret"));
        const QJsonObject empty = ask("getTree", {{"objectId", idOf("emptyPassword")}, {"depth", 0}}).value("tree").toObject();
        QCOMPARE(empty.value("textLength").toInt(), 0);
    }

    void tree_hidesTheSameTextInAWrapper()
    {
        const QJsonObject node = ask("getTree", {{"objectId", idOf("wrapper")}, {"depth", 0}}).value("tree").toObject();
        QVERIFY(!node.contains("text"));
        QCOMPARE(node.value("secret").toBool(), true);
        QCOMPARE(node.value("label").toString(), QString("Password"));
    }

    void properties_hideEveryFormOfTheText()
    {
        for (const char *name : {"text", "displayText"}) {
            const QJsonObject p = property("password", name);
            QVERIFY2(p.value("hidden").toBool(), name);
            QVERIFY2(p.value("value").isNull(), name);
        }
        QVERIFY(!text(ask("getProperties", {{"objectId", idOf("password")}})).contains(kSecret));
        QVERIFY(!text(ask("getProperties", {{"objectId", idOf("wrapper")}})).contains(kSecret));
        QVERIFY(property("wrapper", "text").value("hidden").toBool());
        // A list that holds the text.
        QVERIFY(!text(ask("getProperties", {{"objectId", idOf("copy")}})).contains(kSecret));
        QCOMPARE(property("plain", "text").value("value").toString(), QString("visible text"));
    }

    void find_doesNotMatchOrShowAHiddenText()
    {
        // A search for the right value must not say that it is right.
        QCOMPARE(ask("findByProperty", {{"property", "text"}, {"value", kSecret}}).value("count").toInt(), 0);
        QCOMPARE(ask("findByProperty", {{"property", "text"}, {"value", "visible text"}}).value("count").toInt(), 1);
        const QJsonObject all = ask("findByProperty", {{"property", "text"}});
        QVERIFY(!text(all).contains(kSecret));
        QVERIFY(all.value("count").toInt() >= 4);
        QVERIFY(!text(ask("findByType", {{"typeName", "QQuickTextInput"}})).contains(kSecret));
        QVERIFY(!text(ask("listInteractive")).contains(kSecret));
        QVERIFY(ask("findAndClick", {{"text", kSecret}, {"exact", true}}).contains("error"));
    }

    void evaluate_hidesTheTextWhenItIsTheResult()
    {
        const QJsonObject reply = ask("evaluate", {{"expression", "children[0].text"}});
        QVERIFY2(reply.value("ok").toBool(), text(reply).constData());
        QVERIFY(!text(reply).contains(kSecret));
    }

    // The states a client needs for its list of the screen come with the tree, so it does not have to
    // search the whole tree once per state.
    void tree_carriesTheStates()
    {
        const QJsonObject reply = ask("getTree", {{"depth", 20}});
        QCOMPARE(reply.value("states").toBool(), true);
        const auto node = [&](const QString &name) {
            return ask("getTree", {{"objectId", idOf(name)}, {"depth", 0}}).value("tree").toObject();
        };
        QCOMPARE(node("on").value("checked").toBool(), true);
        QVERIFY(!node("off").contains("checked"));
        // A hidden object is not asked.
        QVERIFY(!node("hiddenOn").contains("checked"));
        QCOMPARE(node("dialog").value("modal").toBool(), true);
        QVERIFY(node("dialog").contains("opened"));
        QCOMPARE(node("dialog").value("opened").toBool(), false);
    }

    // getProperties with "names" reads only those properties, and no other getter of the object runs.
    void properties_withNames_readOnlyThose()
    {
        Counted counted;
        InspectorServer server;
        server.setRootObject(&counted);
        int id = 0;
        const auto ask = [&](const QJsonObject &params) {
            return server.handleCommand(QJsonObject{{"id", ++id}, {"command", "getProperties"}, {"params", params}});
        };
        const QString objectId = server.handleCommand(QJsonObject{{"id", ++id}, {"command", "getTree"}, {"params", QJsonObject{{"depth", 0}}}})
                                     .value("tree").toObject().value("id").toString();
        const QJsonObject some = ask({{"objectId", objectId}, {"names", QJsonArray{"cheap", "noSuchProperty"}}});
        const QJsonArray props = some.value("properties").toArray();
        QCOMPARE(props.size(), 1);
        QCOMPARE(props.first().toObject().value("name").toString(), QString("cheap"));
        QCOMPARE(props.first().toObject().value("value").toInt(), 1);
        QCOMPARE(props.first().toObject().value("writable").toBool(), false);
        QCOMPARE(counted.cheapReads, 1);
        QCOMPARE(counted.costlyReads, 0);
        QVERIFY(!some.contains("methods"));
        // Without names, every property is read, as before.
        const QJsonObject all = ask({{"objectId", objectId}});
        QVERIFY(all.value("properties").toArray().size() >= 3);
        QCOMPARE(counted.costlyReads, 1);
        // The text of a password field stays hidden when it is asked for by name.
        const QJsonObject pw = this->ask("getProperties", {{"objectId", idOf("password")}, {"names", QJsonArray{"text", "echoMode"}}});
        QVERIFY(!text(pw).contains(kSecret));
        QCOMPARE(pw.value("properties").toArray().size(), 2);
    }

    void afterTheFieldShowsItsText_theTextIsSent()
    {
        // "Show password": the app itself now shows the text, so it is not hidden any more.
        QVERIFY(ask("setProperty", {{"objectId", idOf("noEcho")}, {"property", "echoMode"}, {"value", 0}}).value("ok").toBool());
        QCOMPARE(property("noEcho", "text").value("value").toString(), QString("other-Secret-9"));
        QVERIFY(text(ask("getTree", {{"depth", 20}})).contains("other-Secret-9"));
    }
};

int main(int argc, char **argv)
{
    qputenv("QT_QPA_PLATFORM", "offscreen");
    QGuiApplication app(argc, argv);
    tst_Secrets test;
    return QTest::qExec(&test, argc, argv);
}

#include "tst_secrets.moc"
