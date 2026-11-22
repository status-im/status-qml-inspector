// What a password field holds must not be in any reply of the server.
#include <QtTest>
#include <QApplication>
#include <QDialog>
#include <QLineEdit>
#include <QQuickWindow>
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

// Its name is not what was set: the setter keeps another text.
class Stubborn : public QObject
{
    Q_OBJECT
    Q_PROPERTY(QString name READ name WRITE setName)
public:
    QString name() const { return m_name; }
    void setName(const QString &) {}
    QString m_name;
};

class tst_Secrets : public QObject
{
    Q_OBJECT

private:
    QQmlEngine m_engine;
    std::unique_ptr<QObject> m_root;
    std::unique_ptr<InspectorServer> m_serverOwner;
    int m_id = 0;

    QJsonObject ask(const QString &command, const QJsonObject &params = {})
    {
        return m_serverOwner->handleCommand(QJsonObject{{"id", ++m_id}, {"command", command}, {"params", params}});
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
    // A new scene and a new server for every test: no test depends on what another one changed.
    void cleanup()
    {
        m_serverOwner.reset();
        m_root.reset();
    }
    void init()
    {
        m_serverOwner = std::make_unique<InspectorServer>();
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
                Dialog { objectName: "closedDialogWithTitle"; title: "hunter2-Secret!" }
                Item { objectName: "lists" }
                Item { objectName: "guess" }
            }
        )", QUrl());
        m_root.reset(component.create());
        QVERIFY2(m_root, qPrintable(component.errorString()));
        m_serverOwner->setRootObject(m_root.get());
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
        QCOMPARE(property("lists", "names").value("value").toArray(), QJsonArray({"first", QJsonValue::Null}));
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

    void callMethod_sendsNoPasswordText()
    {
        const QJsonObject called = ask("callMethod", {{"objectId", idOf("password")}, {"method", "selectAll"}, {"args", QJsonArray()}});
        QVERIFY2(called.value("ok").toBool(), text(called).constData());
        QVERIFY(!text(called).contains(kSecret));
        QVERIFY(called.value("secretsHidden").toBool());
    }

    // setProperty reads the value back. A value that comes back as the client sent it is the client's own text:
    // it is not checked against the password fields, so the reply does not say whether a guess was right.
    void setProperty_readBack_isNoOracleForAGuess()
    {
        const QString id = idOf("guess");
        const QJsonObject wrong = ask("setProperty", {{"objectId", id}, {"property", "candidate"}, {"value", "not-the-password"}});
        const QJsonObject right = ask("setProperty", {{"objectId", id}, {"property", "candidate"}, {"value", kSecret}});
        QVERIFY(wrong.value("ok").toBool() && right.value("ok").toBool());
        QCOMPARE(wrong.value("value").toString(), QString("not-the-password"));
        QCOMPARE(right.value("value").toString(), QString(kSecret));
        QVERIFY(!wrong.contains("hiddenCount"));
        QVERIFY(!right.contains("hiddenCount"));
        // The same for a list of guesses.
        const QJsonArray guesses{"a", kSecret, "b"};
        const QJsonObject list = ask("setProperty", {{"objectId", id}, {"property", "candidates"}, {"value", guesses}});
        QCOMPARE(list.value("value").toArray(), guesses);
        QVERIFY(!list.contains("hiddenCount"));
    }

    // A value that comes back different from what was sent is a text of the app: it is hidden like any other.
    void setProperty_readBack_hidesATextTheClientDidNotSend()
    {
        Stubborn stubborn;
        stubborn.m_name = kSecret;
        stubborn.setParent(m_root.get());
        const QString id = ask("findByType", {{"typeName", "Stubborn"}}).value("matches").toArray().first().toObject().value("id").toString();
        QVERIFY(!id.isEmpty());
        const QJsonObject set = ask("setProperty", {{"objectId", id}, {"property", "name"}, {"value", "something else"}});
        QVERIFY2(set.value("ok").toBool(), text(set).constData());
        QVERIFY2(!text(set).contains(kSecret), text(set).constData());
        QVERIFY(set.value("value").isNull());
        QCOMPARE(set.value("hiddenCount").toInt(), 1);
        stubborn.setParent(nullptr);
    }

    // A client must not make a field show its text: echoMode of a field that hides its text cannot be set.
    void setProperty_cannotMakeAPasswordFieldShowItsText()
    {
        for (const char *name : {"password", "noEcho"}) {
            const QJsonObject set = ask("setProperty", {{"objectId", idOf(name)}, {"property", "echoMode"}, {"value", 0}});
            QVERIFY2(set.contains("error"), name);
            QVERIFY2(m_root->findChild<QObject*>(name)->property("echoMode").toInt() != 0, name);
            QVERIFY(property(name, "text").value("hidden").toBool());
        }
        // The other way is allowed: a field that shows its text may be made to hide it.
        QVERIFY(ask("setProperty", {{"objectId", idOf("plain")}, {"property", "echoMode"}, {"value", 2}}).value("ok").toBool());
        QVERIFY(property("plain", "text").value("hidden").toBool());
        // And every other property of a password field can still be set.
        QVERIFY(ask("setProperty", {{"objectId", idOf("password")}, {"property", "width"}, {"value", 50}}).value("ok").toBool());
    }

    // An error text of evaluate is a text like any other: the password is taken out of it.
    void evaluate_errorText_hasNoPasswordText()
    {
        const QJsonObject reply = ask("evaluate", {{"expression", "(function(){ throw new Error('got ' + children[0].text + ' here'); })()"}});
        QVERIFY2(reply.contains("error"), text(reply).constData());
        QVERIFY2(!text(reply).contains(kSecret), text(reply).constData());
        QVERIFY(reply.value("error").toString().contains("got (hidden) here"));
        QCOMPARE(reply.value("hiddenCount").toInt(), 1);
        // An error without the password is passed on as it is.
        const QJsonObject plain = ask("evaluate", {{"expression", "(function(){ throw new Error('plain error'); })()"}});
        QVERIFY(plain.value("error").toString().contains("plain error"));
        QVERIFY(!plain.contains("hiddenCount"));
    }

    // One form everywhere: a hidden value is null, and the reply says how many values were hidden.
    void everyReply_saysHowManyValuesWereHidden()
    {
        // Nothing hidden: no count.
        QVERIFY(!ask("getProperties", {{"objectId", idOf("plain")}, {"names", QJsonArray{"width"}}}).contains("hiddenCount"));
        QVERIFY(!ask("getTree", {{"objectId", idOf("plain")}, {"depth", 0}}).contains("hiddenCount"));
        // A property.
        const QJsonObject byName = ask("getProperties", {{"objectId", idOf("password")}, {"names", QJsonArray{"text", "echoMode"}}});
        QCOMPARE(byName.value("hiddenCount").toInt(), 1);
        // Inside a list and a map: null, not a text that the app could hold itself.
        const QJsonObject lists = ask("getProperties", {{"objectId", idOf("lists")}, {"names", QJsonArray{"names", "mixed", "bytes"}}});
        QVERIFY2(!text(lists).contains("(hidden)"), text(lists).constData());
        QCOMPARE(lists.value("hiddenCount").toInt(), 4);
        const QJsonArray mixed = property("lists", "mixed").value("value").toArray();
        QCOMPARE(mixed.at(0).toInt(), 1);
        QVERIFY(mixed.at(1).isNull());
        QVERIFY(mixed.at(2).toObject().value("inner").isNull());
        QVERIFY(property("lists", "bytes").value("value").isNull());
        // The tree.
        const QJsonObject tree = ask("getTree", {{"depth", 20}});
        QVERIFY(tree.value("hiddenCount").toInt() >= 3);
        // A result of evaluate.
        const QJsonObject evaluated = ask("evaluate", {{"expression", "children[0].text"}});
        QVERIFY(evaluated.value("result").isNull());
        QCOMPARE(evaluated.value("hiddenCount").toInt(), 1);
        // A search by value: what was not compared is counted, so the client knows that the list may be short.
        const QJsonObject search = ask("findByProperty", {{"property", "text"}, {"value", "visible text"}});
        QCOMPARE(search.value("count").toInt(), 1);
        QVERIFY(search.value("hiddenCount").toInt() >= 2);
        // The count does not depend on the value that was searched for.
        QCOMPARE(ask("findByProperty", {{"property", "text"}, {"value", kSecret}}).value("hiddenCount").toInt(), search.value("hiddenCount").toInt());
        QVERIFY(ask("listInteractive").value("hiddenCount").toInt() >= 1);
    }

    void typedTextProperties_areAllHidden()
    {
        QObject *field = m_root->findChild<QObject*>("password");
        QVERIFY(QMetaObject::invokeMethod(field, "selectAll"));
        QCOMPARE(field->property("selectedText").toString(), QString(kSecret));
        const QJsonObject reply = ask("getProperties", {{"objectId", idOf("password")}, {"names", QJsonArray{"text", "displayText", "selectedText", "preeditText"}}});
        const QJsonArray props = reply.value("properties").toArray();
        QCOMPARE(props.size(), 4);
        for (const QJsonValue &p : props) {
            QVERIFY2(p.toObject().value("hidden").toBool(), qPrintable(p.toObject().value("name").toString()));
            QVERIFY(p.toObject().value("value").isNull());
        }
        QVERIFY(!text(reply).contains(kSecret));
        // A part of the text that is selected equals no password text: it is hidden because of what the property is.
        QVERIFY(QMetaObject::invokeMethod(field, "select", Q_ARG(int, 0), Q_ARG(int, 4)));
        QCOMPARE(field->property("selectedText").toString(), QString("hunt"));
        const QJsonObject part = ask("getProperties", {{"objectId", idOf("password")}, {"names", QJsonArray{"selectedText"}}});
        QVERIFY(part.value("properties").toArray().first().toObject().value("hidden").toBool());
        QVERIFY2(!text(part).contains("hunt"), text(part).constData());
        // Also when every property is read, and in a search for the property.
        for (const char *name : {"selectedText", "preeditText", "displayText"}) {
            QVERIFY2(property("password", name).value("hidden").toBool(), name);
            QVERIFY2(!text(ask("findByProperty", {{"property", name}})).contains(kSecret), name);
        }
    }

    // Titles: of a window, of an open popup, of a closed dialog, of a widget dialog.
    void titles_thatEqualAPassword_areLeftOut()
    {
        QQmlComponent component(&m_engine);
        component.setData(R"(
            import QtQuick
            import QtQuick.Controls
            ApplicationWindow {
                width: 300; height: 200; visible: true
                title: "hunter2-Secret!"
                TextInput { objectName: "windowPassword"; echoMode: TextInput.Password; text: "hunter2-Secret!" }
                Dialog { objectName: "openDialog"; title: "hunter2-Secret!"; modal: false; visible: true; width: 100; height: 80 }
                Dialog { objectName: "otherDialog"; title: "Settings"; modal: false; visible: true; width: 100; height: 80 }
            }
        )", QUrl());
        std::unique_ptr<QObject> window(component.create());
        QVERIFY2(window, qPrintable(component.errorString()));
        QVERIFY(QTest::qWaitFor([&] { return window->findChild<QObject*>("openDialog")->property("opened").toBool()
                                          && window->findChild<QObject*>("otherDialog")->property("opened").toBool(); }, 3000));
        InspectorServer server;
        server.setRootObject(window.get());
        const QJsonObject tree = server.handleCommand(QJsonObject{{"id", 1}, {"command", "getTree"}, {"params", QJsonObject{{"depth", 40}}}});
        QVERIFY(tree.value("ok").toBool());
        QVERIFY2(!text(tree).contains(kSecret), text(tree).constData());
        // The window says that something was left out, and the title of the other dialog is there, on its popup item.
        QVERIFY(!tree.value("tree").toObject().contains("title"));
        QCOMPARE(tree.value("tree").toObject().value("secret").toBool(), true);
        QVERIFY(text(tree).contains("\"title\": \"Settings\""));
        QVERIFY(text(tree).contains("\"popup\""));
        QVERIFY(tree.value("hiddenCount").toInt() >= 3);

        // A closed dialog of the main scene.
        const QJsonObject closed = ask("getTree", {{"objectId", idOf("closedDialogWithTitle")}, {"depth", 0}}).value("tree").toObject();
        QVERIFY(!closed.contains("title"));
        QCOMPARE(closed.value("secret").toBool(), true);

        // A widget dialog with a QLineEdit that hides its text.
        QDialog dialog;
        dialog.setObjectName("widgetDialog");
        dialog.setWindowTitle(kSecret);
        QLineEdit edit(&dialog);
        edit.setEchoMode(QLineEdit::Password);
        edit.setText(kSecret);
        QLineEdit shown(&dialog);
        shown.setText("shown in a widget");
        InspectorServer widgets;
        widgets.setRootObject(&dialog);
        const QJsonObject widgetTree = widgets.handleCommand(QJsonObject{{"id", 1}, {"command", "getTree"}, {"params", QJsonObject{{"depth", 5}}}});
        QVERIFY(widgetTree.value("ok").toBool());
        QVERIFY2(!text(widgetTree).contains(kSecret), text(widgetTree).constData());
        QVERIFY(text(widgetTree).contains("shown in a widget"));
        QVERIFY(!widgetTree.value("tree").toObject().contains("title"));
    }

    // The tree is walked for the password texts only by a command whose reply holds a text of the app.
    void commandsThatSendNoText_doNotWalkTheTree()
    {
        const QString id = idOf("password");
        const QString plain = idOf("plain");
        int walks = m_serverOwner->secretLookups();
        const auto walked = [&] { const int now = m_serverOwner->secretLookups(); const int n = now - walks; walks = now; return n; };
        QVERIFY(ask("getProperties", {{"objectId", id}, {"names", QJsonArray{"echoMode", "width", "visible"}}}).value("ok").toBool());
        QCOMPARE(walked(), 0);
        ask("geometry", {{"objectId", plain}});
        QCOMPARE(walked(), 0);
        QVERIFY(ask("callMethod", {{"objectId", id}, {"method", "selectAll"}, {"args", QJsonArray()}}).value("ok").toBool());
        QCOMPARE(walked(), 0);
        QVERIFY(ask("setProperty", {{"objectId", plain}, {"property", "width"}, {"value", 60}}).value("ok").toBool());
        QCOMPARE(walked(), 0);
        // The text of a field that hides it is known to be hidden without a walk.
        QVERIFY(ask("getProperties", {{"objectId", id}, {"names", QJsonArray{"text"}}}).value("ok").toBool());
        QCOMPARE(walked(), 0);
        // A text of another object must be compared with the password texts: one walk for the command, not one per value.
        QVERIFY(ask("getProperties", {{"objectId", plain}, {"names", QJsonArray{"text", "displayText"}}}).value("ok").toBool());
        QCOMPARE(walked(), 1);
        QVERIFY(ask("getTree", {{"depth", 20}}).value("ok").toBool());
        QCOMPARE(walked(), 1);
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

    void afterTheAppShowsTheText_theTextIsSent()
    {
        // "Show password": the app itself shows the text on the screen now, so it is not hidden any more.
        QObject *field = m_root->findChild<QObject*>("noEcho");
        QVERIFY(property("noEcho", "text").value("hidden").toBool());
        field->setProperty("echoMode", 0);
        QCOMPARE(property("noEcho", "text").value("value").toString(), QString("other-Secret-9"));
        QVERIFY(text(ask("getTree", {{"depth", 20}})).contains("other-Secret-9"));
    }
};

int main(int argc, char **argv)
{
    qputenv("QT_QPA_PLATFORM", "offscreen");
    QApplication app(argc, argv);
    tst_Secrets test;
    return QTest::qExec(&test, argc, argv);
}

#include "tst_secrets.moc"
