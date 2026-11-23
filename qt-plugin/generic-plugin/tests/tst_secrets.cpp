// A client that has sent the command "hideSecrets" gets no reply that holds what a password field holds.
// Every other client gets these texts as before: the cases "byDefault_..." check that. The state belongs to one
// connection: the cases "twoClients_...", "overTheSocket_..." and "relay_..." check that.
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
#include <QTcpSocket>
#include <QHostAddress>

#include "inspectorserver.h"
#include "relayclient.h"

// 18 characters: the server takes no token shorter than 16.
#define TOKEN "s3cret-of-16-chars"

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

// Its method runs a request of another client and then returns a text: a command inside a command, as when code of
// the app that a command runs lets the server read its sockets.
class Reentrant : public QObject
{
    Q_OBJECT
public:
    using QObject::QObject;
    Q_INVOKABLE QString askAsOther()
    {
        lastReply = server->handleCommand(QJsonObject{{"id", 900}, {"command", "getTree"}, {"params", QJsonObject{{"depth", 20}}}}, *session);
        return QString::fromLatin1(kSecret);
    }
    InspectorServer *server = nullptr;
    InspectorServer::Session *session = nullptr;
    QJsonObject lastReply;
};

class tst_Secrets : public QObject
{
    Q_OBJECT

private:
    QQmlEngine m_engine;
    std::unique_ptr<QObject> m_root;
    std::unique_ptr<InspectorServer> m_serverOwner;
    // The client that ask() speaks for. init() sends "hideSecrets" for it.
    InspectorServer::Session m_session;
    int m_id = 0;

    QJsonObject ask(const QString &command, const QJsonObject &params = {})
    {
        return askAs(m_session, command, params);
    }
    QJsonObject askAs(InspectorServer::Session &session, const QString &command, const QJsonObject &params = {})
    {
        return m_serverOwner->handleCommand(QJsonObject{{"id", ++m_id}, {"command", command}, {"params", params}}, session);
    }
    // The same over a real connection. An empty object when the server sent no line.
    QJsonObject askOver(QTcpSocket &socket, const QString &command, const QJsonObject &params = {})
    {
        socket.write(QJsonDocument(QJsonObject{{"id", ++m_id}, {"command", command}, {"params", params}}).toJson(QJsonDocument::Compact) + '\n');
        (void) QTest::qWaitFor([&socket] { return socket.canReadLine() || socket.state() == QAbstractSocket::UnconnectedState; }, 3000);
        return QJsonDocument::fromJson(socket.readLine()).object();
    }
    static bool connectTo(QTcpSocket &socket, int port)
    {
        socket.connectToHost(QHostAddress::LocalHost, port);
        return socket.waitForConnected(2000);
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

    // A client that has sent nothing yet: the hiding is off for it.
    void useANewClient()
    {
        m_session = InspectorServer::Session();
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
        m_session = InspectorServer::Session();
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
        // Every case runs as a client that has asked for the hiding, except those that call useANewClient().
        QVERIFY(ask("hideSecrets").value("ok").toBool());
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
        InspectorServer::Session session;
        QVERIFY(server.handleCommand(QJsonObject{{"id", 1}, {"command", "hideSecrets"}}, session).value("ok").toBool());
        const QJsonObject tree = server.handleCommand(QJsonObject{{"id", 1}, {"command", "getTree"}, {"params", QJsonObject{{"depth", 40}}}}, session);
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
        InspectorServer::Session widgetSession;
        QVERIFY(widgets.handleCommand(QJsonObject{{"id", 1}, {"command", "hideSecrets"}}, widgetSession).value("ok").toBool());
        const QJsonObject widgetTree = widgets.handleCommand(QJsonObject{{"id", 1}, {"command", "getTree"}, {"params", QJsonObject{{"depth", 5}}}}, widgetSession);
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
        InspectorServer::Session session;
        int id = 0;
        const auto ask = [&](const QJsonObject &params) {
            return server.handleCommand(QJsonObject{{"id", ++id}, {"command", "getProperties"}, {"params", params}}, session);
        };
        const QString objectId = server.handleCommand(QJsonObject{{"id", ++id}, {"command", "getTree"}, {"params", QJsonObject{{"depth", 0}}}}, session)
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

    // --- The default: the hiding is off, and the plugin sends what a password field holds, as it did before. ---

    void byDefault_theTreeHasThePasswordText()
    {
        useANewClient();
        const QJsonObject reply = ask("getTree", {{"depth", 20}});
        QVERIFY(reply.value("ok").toBool());
        QVERIFY(text(reply).contains(kSecret));
        QVERIFY(text(reply).contains("other-Secret-9"));
        // Nothing says that something was hidden: a client that hides the text itself (the MCP server) goes by this.
        QVERIFY(!reply.contains("secretsHidden"));
        QVERIFY(!reply.contains("hiddenCount"));
        const QJsonObject node = ask("getTree", {{"objectId", idOf("password")}, {"depth", 0}}).value("tree").toObject();
        QCOMPARE(node.value("text").toString(), QString(kSecret));
        // The titles that equal the text are sent too.
        QVERIFY(text(ask("listFileDialogs")).contains(kSecret));
    }

    // The mark of a password field stays in both modes: it changes no value.
    void byDefault_theTreeStillMarksAPasswordField()
    {
        useANewClient();
        const QJsonObject node = ask("getTree", {{"objectId", idOf("password")}, {"depth", 0}}).value("tree").toObject();
        QCOMPARE(node.value("secret").toBool(), true);
        QCOMPARE(node.value("textLength").toInt(), int(strlen(kSecret)));
        QCOMPARE(node.value("echoMode").toInt(), 2);
        // Only the field itself has the mark: a wrapper with the same text has none.
        const QJsonObject wrapper = ask("getTree", {{"objectId", idOf("wrapper")}, {"depth", 0}}).value("tree").toObject();
        QCOMPARE(wrapper.value("text").toString(), QString(kSecret));
        QVERIFY(!wrapper.contains("secret"));
        const QJsonObject plain = ask("getTree", {{"objectId", idOf("plain")}, {"depth", 0}}).value("tree").toObject();
        QVERIFY(!plain.contains("secret"));
    }

    void byDefault_propertiesGiveThePasswordText()
    {
        useANewClient();
        for (const char *name : {"text", "displayText"}) {
            const QJsonObject p = property("password", name);
            QVERIFY2(!p.contains("hidden"), name);
        }
        QCOMPARE(property("password", "text").value("value").toString(), QString(kSecret));
        QCOMPARE(property("wrapper", "text").value("value").toString(), QString(kSecret));
        QCOMPARE(property("lists", "names").value("value").toArray(), QJsonArray({"first", kSecret}));
        const QJsonObject named = ask("getProperties", {{"objectId", idOf("password")}, {"names", QJsonArray{"text"}}});
        QCOMPARE(named.value("properties").toArray().first().toObject().value("value").toString(), QString(kSecret));
        QVERIFY(!named.contains("secretsHidden"));
        QVERIFY(!named.contains("hiddenCount"));
    }

    void byDefault_aSearchByValueComparesThePasswordText()
    {
        useANewClient();
        const QJsonObject found = ask("findByProperty", {{"property", "text"}, {"value", kSecret}});
        // The field and its wrapper are among the matches, with the text as their value.
        QStringList names;
        for (const QJsonValue &match : found.value("matches").toArray()) {
            names << match.toObject().value("objectName").toString();
            QCOMPARE(match.toObject().value("value").toString(), QString(kSecret));
        }
        QVERIFY2(names.contains("password") && names.contains("wrapper"), qPrintable(names.join(',')));
        QVERIFY(!found.contains("hiddenCount"));
        QCOMPARE(ask("evaluate", {{"expression", "children[0].text"}}).value("result").toString(), QString(kSecret));
    }

    void byDefault_echoModeOfAPasswordFieldCanBeSet()
    {
        useANewClient();
        const QJsonObject set = ask("setProperty", {{"objectId", idOf("password")}, {"property", "echoMode"}, {"value", 0}});
        QVERIFY2(set.value("ok").toBool(), text(set).constData());
        QCOMPARE(m_root->findChild<QObject*>("password")->property("echoMode").toInt(), 0);
    }

    void byDefault_anErrorTextOfEvaluateIsNotChanged()
    {
        useANewClient();
        const QJsonObject reply = ask("evaluate", {{"expression", "(function(){ throw new Error('got ' + children[0].text + ' here'); })()"}});
        QVERIFY2(reply.value("error").toString().contains(QString("got %1 here").arg(kSecret)), text(reply).constData());
        QVERIFY(!reply.contains("hiddenCount"));
    }

    // With the hiding off no command walks the tree for the texts of password fields.
    void byDefault_noCommandLooksForPasswordTexts()
    {
        useANewClient();
        ask("getTree", {{"depth", 20}});
        ask("getProperties", {{"objectId", idOf("password")}});
        ask("listInteractive");
        QCOMPARE(m_serverOwner->secretLookups(), 0);
    }

    // --- The command, and whose replies it changes. ---

    void theCommand_turnsTheHidingOnForItsClient()
    {
        useANewClient();
        QVERIFY(text(ask("getTree", {{"depth", 20}})).contains(kSecret));
        const QJsonObject on = ask("hideSecrets");
        QVERIFY2(on.value("ok").toBool(), text(on).constData());
        // The reply to the command says it already, so a client needs no second request to know.
        QCOMPARE(on.value("secretsHidden").toBool(), true);
        const QJsonObject tree = ask("getTree", {{"depth", 20}});
        QVERIFY(!text(tree).contains(kSecret));
        QCOMPARE(tree.value("secretsHidden").toBool(), true);
        QVERIFY(property("password", "text").value("hidden").toBool());
    }

    // Nothing turns it off again: not a second command, and no parameter.
    void theCommand_cannotBeTakenBack()
    {
        useANewClient();
        QVERIFY(ask("hideSecrets").value("ok").toBool());
        for (const QJsonObject &params : {QJsonObject{{"hide", false}}, QJsonObject{{"enabled", false}}, QJsonObject{{"value", 0}}, QJsonObject{}}) {
            QVERIFY(ask("hideSecrets", params).value("secretsHidden").toBool());
            QVERIFY2(!text(ask("getTree", {{"depth", 20}})).contains(kSecret), text(params).constData());
        }
        QVERIFY(ask("setProperty", {{"objectId", idOf("password")}, {"property", "echoMode"}, {"value", 0}}).contains("error"));
    }

    // Two clients of one server, one with the hiding and one without: each gets its own kind of reply, in any
    // order of their requests. (The texts of the password fields are looked up for one command only.)
    void twoClients_doNotAffectEachOther()
    {
        InspectorServer::Session hiding, plain;
        QVERIFY(askAs(hiding, "hideSecrets").value("ok").toBool());
        const QJsonObject tree{{"depth", 20}};
        const QJsonObject byValue{{"property", "text"}, {"value", kSecret}};
        const auto checkHiding = [&] {
            const QJsonObject reply = askAs(hiding, "getTree", tree);
            QVERIFY(!text(reply).contains(kSecret));
            QCOMPARE(reply.value("secretsHidden").toBool(), true);
            QVERIFY(reply.value("hiddenCount").toInt() > 0);
            QCOMPARE(askAs(hiding, "findByProperty", byValue).value("count").toInt(), 0);
        };
        const auto checkPlain = [&] {
            const QJsonObject reply = askAs(plain, "getTree", tree);
            QVERIFY(text(reply).contains(kSecret));
            QVERIFY(!reply.contains("secretsHidden"));
            QVERIFY(!reply.contains("hiddenCount"));
            QVERIFY(askAs(plain, "findByProperty", byValue).value("count").toInt() >= 2);
            const QJsonObject error = askAs(plain, "evaluate", {{"expression", "(function(){ throw new Error('got ' + children[0].text); })()"}});
            QVERIFY(error.value("error").toString().contains(kSecret));
        };
        for (int round = 0; round < 3; ++round) {
            checkHiding();
            checkPlain();
            checkPlain();
            checkHiding();
        }
        // A client that comes later starts without the hiding.
        InspectorServer::Session late;
        QVERIFY(text(askAs(late, "getTree", tree)).contains(kSecret));
    }

    // A request of one client that runs while a command of another client is not finished changes nothing for the
    // outer one, in either direction.
    void aCommandInsideACommand_doesNotChangeTheOuterClient()
    {
        auto *inner = new Reentrant(m_root.get());
        inner->setObjectName("reentrant");
        inner->server = m_serverOwner.get();
        // The result of the script is the text of the password field: it shows whose rule the outer command follows.
        const QJsonObject call{{"objectId", idOf("reentrant")}, {"expression", "askAsOther()"}};
        QVERIFY(!call.value("objectId").toString().isEmpty());

        // Outside a client with the hiding, inside one without.
        InspectorServer::Session plain;
        inner->session = &plain;
        QJsonObject outer = ask("evaluate", call);
        QVERIFY2(outer.value("ok").toBool(), text(outer).constData());
        QVERIFY(text(inner->lastReply).contains(kSecret));
        QVERIFY(!inner->lastReply.contains("secretsHidden"));
        QVERIFY2(!text(outer).contains(kSecret), text(outer).constData());
        QVERIFY(outer.value("result").isNull());
        QCOMPARE(outer.value("secretsHidden").toBool(), true);
        QCOMPARE(outer.value("hiddenCount").toInt(), 1);

        // Outside a client without the hiding, inside one with it.
        inner->session = &m_session;
        outer = askAs(plain, "evaluate", call);
        QVERIFY(!text(inner->lastReply).contains(kSecret));
        QCOMPARE(inner->lastReply.value("secretsHidden").toBool(), true);
        QCOMPARE(outer.value("result").toString(), QString(kSecret));
        QVERIFY(!outer.contains("secretsHidden"));
        QVERIFY(!outer.contains("hiddenCount"));
    }

    // The same over real connections: the state is kept for the connection that sent the command, and ends with it.
    void overTheSocket_theHidingBelongsToOneConnection()
    {
        m_serverOwner->start(0);
        QVERIFY(m_serverOwner->port() > 0);
        const QJsonObject tree{{"depth", 20}};
        QTcpSocket first, second;
        QVERIFY(connectTo(first, m_serverOwner->port()));
        QVERIFY(connectTo(second, m_serverOwner->port()));
        QVERIFY(text(askOver(first, "getTree", tree)).contains(kSecret));
        QCOMPARE(askOver(first, "hideSecrets").value("secretsHidden").toBool(), true);
        for (int round = 0; round < 2; ++round) {
            const QJsonObject hidden = askOver(first, "getTree", tree);
            QVERIFY(hidden.value("ok").toBool());
            QVERIFY(!text(hidden).contains(kSecret));
            QCOMPARE(hidden.value("secretsHidden").toBool(), true);
            const QJsonObject shown = askOver(second, "getTree", tree);
            QVERIFY(text(shown).contains(kSecret));
            QVERIFY(!shown.contains("secretsHidden"));
        }
        // A new connection of the same client starts without it: the client sends the command again.
        first.disconnectFromHost();
        QTcpSocket again;
        QVERIFY(connectTo(again, m_serverOwner->port()));
        QVERIFY(text(askOver(again, "getTree", tree)).contains(kSecret));
    }

    // With a token the command is a command like any other: before the token it is refused and the connection is closed.
    void overTheSocket_withAToken_theCommandNeedsTheTokenFirst()
    {
        m_serverOwner->setAuthToken(TOKEN);
        m_serverOwner->start(0);
        QVERIFY(m_serverOwner->port() > 0);
        QTcpSocket early;
        QVERIFY(connectTo(early, m_serverOwner->port()));
        const QJsonObject refused = askOver(early, "hideSecrets");
        QVERIFY2(refused.value("error").toString().startsWith("Authentication required"), text(refused).constData());
        QVERIFY(!refused.contains("secretsHidden"));
        QVERIFY(QTest::qWaitFor([&early] { return early.state() == QAbstractSocket::UnconnectedState; }, 2000));

        QTcpSocket good;
        QVERIFY(connectTo(good, m_serverOwner->port()));
        QCOMPARE(askOver(good, "auth", {{"token", TOKEN}}).value("auth").toString(), QString("accepted"));
        QCOMPARE(askOver(good, "hideSecrets").value("secretsHidden").toBool(), true);
        QVERIFY(!text(askOver(good, "getTree", {{"depth", 20}})).contains(kSecret));
    }

    // Dial-out mode: the relay client is one client. It gets the texts until the relay sends the command, and
    // none after that, for as long as the app runs.
    void relay_theCommandTurnsTheHidingOnForTheRelay()
    {
        InspectorRelayClient relay(m_serverOwner.get(), QUrl("http://localhost:1"), TOKEN);
        const QJsonObject tree{{"id", 1}, {"command", "getTree"}, {"params", QJsonObject{{"depth", 20}}}};
        const QJsonObject before = relay.run(tree);
        QVERIFY(before.value("ok").toBool());
        QVERIFY(text(before).contains(kSecret));
        QVERIFY(!before.contains("secretsHidden"));
        const QJsonObject on = relay.run(QJsonObject{{"id", 2}, {"command", "hideSecrets"}});
        QVERIFY2(on.value("ok").toBool(), text(on).constData());
        QCOMPARE(on.value("id").toInt(), 2);
        for (int round = 0; round < 2; ++round) {
            const QJsonObject after = relay.run(tree);
            QVERIFY(!text(after).contains(kSecret));
            QCOMPARE(after.value("secretsHidden").toBool(), true);
        }
        // A client of the listening kind is not changed by it.
        useANewClient();
        QVERIFY(text(ask("getTree", {{"depth", 20}})).contains(kSecret));
        // The commands that change the app stay refused.
        QVERIFY(relay.run(QJsonObject{{"id", 3}, {"command", "setProperty"}}).value("error").toString().startsWith("Not available through a relay"));
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
