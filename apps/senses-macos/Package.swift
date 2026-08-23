// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ClaurpSenses",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "ClaurpSensesCore", targets: ["ClaurpSensesCore"])
    ],
    targets: [
        .target(
            name: "ClaurpSensesCore",
            path: "Sources/ClaurpSensesCore"
        ),
        .testTarget(
            name: "ClaurpSensesCoreTests",
            dependencies: ["ClaurpSensesCore"],
            path: "Tests/ClaurpSensesCoreTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
