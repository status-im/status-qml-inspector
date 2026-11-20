cmake_minimum_required(VERSION 3.16)
project(qmlinspector_tests LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 REQUIRED COMPONENTS Core Network Test)

enable_testing()
add_executable(tst_relayurl tst_relayurl.cpp)
target_include_directories(tst_relayurl PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/..)
target_link_libraries(tst_relayurl PRIVATE Qt6::Core Qt6::Network Qt6::Test)
add_test(NAME tst_relayurl COMMAND tst_relayurl)
