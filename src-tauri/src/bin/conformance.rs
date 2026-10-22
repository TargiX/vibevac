//! Conformance harness: reads one fixture description as JSON on stdin and
//! prints the native engine's WorkspaceReport as JSON on stdout. Driven by
//! test/conformance/conformance.test.ts.

use std::io::Read;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut input = String::new();
    if let Err(error) = std::io::stdin().read_to_string(&mut input) {
        eprintln!("Could not read stdin: {error}");
        return ExitCode::FAILURE;
    }
    match vibevac_lib::run_conformance_json(&input) {
        Ok(output) => {
            println!("{output}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}
