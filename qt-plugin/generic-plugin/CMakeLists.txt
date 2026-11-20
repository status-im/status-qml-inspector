cmake_minimum_required(VERSION 3.16)
project(qmlinspector LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 REQUIRED COMPONENTS Core Gui Network Qml Quick Widgets)

# QQuickWidget support is only useful for widget-hosted apps and needs the
# QuickWidgets module at runtime; status-app's Android APK does not bundle it.
option(QMLINSPECTOR_QUICKWIDGETS "Support QQuickWidget-hosted QML" ON)
if(ANDROID)
    set(QMLINSPECTOR_QUICKWIDGETS OFF)
endif()
if(QMLINSPECTOR_QUICKWIDGETS)
    find_package(Qt6 REQUIRED COMPONENTS QuickWidgets)
endif()

qt_add_plugin(qmlinspector SHARED PLUGIN_TYPE generic CLASS_NAME QmlInspectorPlugin)

target_sources(qmlinspector PRIVATE
    ../inspectorserver.h
    ../inspectorserver.cpp
    relayclient.h
    relayclient.cpp
    relayurl.h
    qmlinspectorplugin.cpp
    qmlinspector.json
)

target_include_directories(qmlinspector PRIVATE ${CMAKE_CURRENT_SOURCE_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/..)

target_link_libraries(qmlinspector PRIVATE
    Qt6::Core
    Qt6::Gui
    Qt6::Network
    Qt6::Qml
    Qt6::Quick
    Qt6::Widgets
)
if(QMLINSPECTOR_QUICKWIDGETS)
    target_link_libraries(qmlinspector PRIVATE Qt6::QuickWidgets)
    target_compile_definitions(qmlinspector PRIVATE QMLINSPECTOR_HAVE_QUICKWIDGETS=1)
else()
    target_compile_definitions(qmlinspector PRIVATE QMLINSPECTOR_HAVE_QUICKWIDGETS=0)
endif()

# Qt looks for generic plugins under <QT_PLUGIN_PATH entry>/generic/
set_target_properties(qmlinspector PROPERTIES
    LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/plugins/generic
)
