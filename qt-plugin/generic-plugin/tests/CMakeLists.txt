cmake_minimum_required(VERSION 3.16)
project(qmlinspector_tests LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 REQUIRED COMPONENTS Core Gui Network Qml Quick Widgets Test)

enable_testing()
add_executable(tst_relayurl tst_relayurl.cpp)
target_include_directories(tst_relayurl PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/..)
target_link_libraries(tst_relayurl PRIVATE Qt6::Core Qt6::Network Qt6::Test)
add_test(NAME tst_relayurl COMMAND tst_relayurl)

# The token check of the listening server, with the real server on a local socket.
add_executable(tst_authtoken tst_authtoken.cpp ../../inspectorserver.h ../../inspectorserver.cpp)
target_include_directories(tst_authtoken PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/../..)
target_compile_definitions(tst_authtoken PRIVATE QMLINSPECTOR_HAVE_QUICKWIDGETS=0)
target_link_libraries(tst_authtoken PRIVATE Qt6::Core Qt6::Gui Qt6::Network Qt6::Qml Qt6::Quick Qt6::Widgets Qt6::Test)
add_test(NAME tst_authtoken COMMAND tst_authtoken)
