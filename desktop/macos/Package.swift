// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "ProjectRoomMac", platforms: [.macOS(.v14)],
    products: [.executable(name: "ProjectRoom", targets: ["ProjectRoom"]), .executable(name: "LocalToolsAcceptance", targets: ["LocalToolsAcceptance"]), .executable(name: "ProjectRoomTools", targets: ["ProjectRoomTools"]), .executable(name: "RoomAcceptance", targets: ["RoomAcceptance"])],
    targets: [.target(name: "ProjectRoomKit"), .executableTarget(name: "ProjectRoom", dependencies: ["ProjectRoomKit"]), .executableTarget(name: "ProjectRoomTools", dependencies: ["ProjectRoomKit"]), .executableTarget(name: "LocalToolsAcceptance", dependencies: ["ProjectRoomKit"]), .executableTarget(name: "RoomAcceptance", dependencies: ["ProjectRoomKit"])])
