cmake_minimum_required(VERSION 3.16)
project(qmlinspector_tests LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 REQUIRED COMPONENTS Core Network Test)
# The tests of the server itself (the token check, password fields) need the GUI modules.
find_package(Qt6 QUIET COMPONENTS Gui Qml Quick Widgets)
# Without these modules the two security tests cannot be built. That is an error, so that a test run cannot pass
# without them unnoticed. Turn this ON only to build the small tests on a machine that has Qt Core alone.
option(QMLINSPECTOR_TESTS_WITHOUT_GUI "Build only the tests that need no GUI module (the security tests are left out)" OFF)

enable_testing()
add_executable(tst_relayurl tst_relayurl.cpp)
target_include_directories(tst_relayurl PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/..)
target_link_libraries(tst_relayurl PRIVATE Qt6::Core Qt6::Network Qt6::Test)
add_test(NAME tst_relayurl COMMAND tst_relayurl)

add_executable(tst_envswitch tst_envswitch.cpp)
target_include_directories(tst_envswitch PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/..)
target_link_libraries(tst_envswitch PRIVATE Qt6::Core Qt6::Test)
add_test(NAME tst_envswitch COMMAND tst_envswitch)

# tst_startplan: what the plugin does when it is created (off, listen, relay), from the environment alone.
add_executable(tst_startplan tst_startplan.cpp)
target_include_directories(tst_startplan PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/.. ${CMAKE_CURRENT_SOURCE_DIR}/../..)
target_link_libraries(tst_startplan PRIVATE Qt6::Core Qt6::Network Qt6::Test)
add_test(NAME tst_startplan COMMAND tst_startplan)

if(TARGET Qt6::Gui AND TARGET Qt6::Qml AND TARGET Qt6::Quick AND TARGET Qt6::Widgets)
    # tst_authtoken: the token check, with the real server on a local socket.
    # tst_secrets: the text of password fields is in no reply.
    # tst_secrets also has the relay client: the same rule for password fields holds in dial-out mode.
    foreach(name tst_authtoken tst_secrets)
        add_executable(${name} ${name}.cpp ../../inspectorserver.h ../../inspectorserver.cpp ../relayclient.h ../relayclient.cpp)
        target_include_directories(${name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../.. ${CMAKE_CURRENT_SOURCE_DIR}/..)
        target_compile_definitions(${name} PRIVATE QMLINSPECTOR_HAVE_QUICKWIDGETS=0)
        target_link_libraries(${name} PRIVATE Qt6::Core Qt6::Gui Qt6::Network Qt6::Qml Qt6::Quick Qt6::Widgets Qt6::Test)
        add_test(NAME ${name} COMMAND ${name})
    endforeach()
elseif(QMLINSPECTOR_TESTS_WITHOUT_GUI)
    message(WARNING "Qt Gui, Qml, Quick or Widgets not found: tst_authtoken and tst_secrets are NOT built. "
                    "The token check and the hiding of password fields are not tested in this build.")
else()
    message(FATAL_ERROR "Qt Gui, Qml, Quick or Widgets not found: tst_authtoken and tst_secrets cannot be built. "
                        "Install these modules, or pass -DQMLINSPECTOR_TESTS_WITHOUT_GUI=ON to build only the tests that need none "
                        "(the token check and the hiding of password fields are then not tested).")
endif()
