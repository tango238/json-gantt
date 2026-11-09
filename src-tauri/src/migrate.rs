use serde_json::Value;

use crate::error::AppError;

pub const CURRENT_VERSION: i64 = 1;

/// Migrates a parsed document to `CURRENT_VERSION`.
/// Returns the value and `Some((from, to))` when a migration was applied.
pub fn run(value: Value) -> Result<(Value, Option<(i64, i64)>), AppError> {
    let Some(found) = value.get("version").and_then(Value::as_i64) else {
        // Missing or non-integer: the schema validation reports it.
        return Ok((value, None));
    };
    if found > CURRENT_VERSION {
        return Err(AppError::UnsupportedVersion {
            found,
            supported: CURRENT_VERSION,
        });
    }
    if found < 1 {
        // Left to the schema `const` error.
        return Ok((value, None));
    }
    // found == CURRENT_VERSION: nothing to migrate. Future versions chain
    // `migrate_v{n}_to_v{n+1}` here.
    Ok((value, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn current_version_passes_through() {
        let (v, m) = run(json!({"version": 1})).unwrap();
        assert_eq!(v, json!({"version": 1}));
        assert!(m.is_none());
    }

    #[test]
    fn newer_version_is_unsupported() {
        match run(json!({"version": 2})) {
            Err(AppError::UnsupportedVersion {
                found: 2,
                supported: 1,
            }) => {}
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn missing_or_bad_version_is_left_to_schema() {
        assert!(run(json!({})).unwrap().1.is_none());
        assert!(run(json!({"version": "1"})).is_ok());
        assert!(run(json!({"version": 0})).is_ok());
    }
}
