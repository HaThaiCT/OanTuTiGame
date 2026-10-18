fn main() -> std::io::Result<()> {
    let schema = "../../packages/protocol/proto/execution.proto";
    println!("cargo:rerun-if-changed={schema}");
    prost_build::compile_protos(&[schema], &["../../packages/protocol/proto"])
}
