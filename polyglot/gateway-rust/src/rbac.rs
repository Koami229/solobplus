use serde::Serialize;
use crate::error::AppError;

pub const ALL_ROLES: &[&str] = &["student", "teacher", "org_client", "contributor", "reviewer", "operator", "admin"];
pub const PUBLIC_SELF_REGISTER_ROLES: &[&str] = &["student", "org_client", "contributor"];
pub const PRIVILEGED_OR_VERIFIED_ROLES: &[&str] = &["admin", "operator", "reviewer", "teacher"];
pub const SCHOOL_ROLES: &[&str] = &["student", "teacher", "admin"];
pub const BUSINESS_ROLES: &[&str] = &["org_client", "contributor", "reviewer", "operator", "admin"];
pub const OPERATOR_ROLES: &[&str] = &["operator", "admin"];

pub fn pillar_for_role(role: &str) -> &'static str {
    match role {
        "student" | "teacher" => "school",
        "org_client" | "contributor" | "reviewer" | "operator" => "business",
        _ => "core",
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: String,
    pub email: String,
    pub full_name: String,
    pub role: String,
    pub pillar: String,
    pub preferred_ui_lang: String,
    pub country_code: String,
    pub is_active: bool,
}

/// Pure decision (audit is recorded by the caller). Same codes as rbac.ts.
pub fn check_role(user: Option<&AuthUser>, allowed: &[&str], pillar: &str, op: &str) -> Result<(), AppError> {
    let Some(u) = user else {
        return Err(AppError::new(401, "UNAUTHENTICATED", "Authentication required to perform this action."));
    };
    if !u.is_active { return Err(AppError::new(403, "ACCOUNT_DISABLED", "Account is inactive.")); }
    if !allowed.contains(&u.role.as_str()) {
        return Err(AppError::new(403, "FORBIDDEN_ROLE", &format!(
            "Role '{}' is not authorized for '{}' in pillar '{}'. Allowed roles: {}.", u.role, op, pillar, allowed.join(", "))));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn u(role: &str, active: bool) -> AuthUser {
        AuthUser { id: "u".into(), email: "e".into(), full_name: "n".into(), role: role.into(),
            pillar: pillar_for_role(role).into(), preferred_ui_lang: "fr".into(), country_code: "BJ".into(), is_active: active }
    }
    #[test]
    fn matrix() {
        assert_eq!(check_role(None, SCHOOL_ROLES, "school", "x").unwrap_err().status, 401);
        assert_eq!(check_role(Some(&u("student", false)), SCHOOL_ROLES, "school", "x").unwrap_err().code, "ACCOUNT_DISABLED");
        assert!(check_role(Some(&u("student", true)), SCHOOL_ROLES, "school", "x").is_ok());
        assert_eq!(check_role(Some(&u("student", true)), BUSINESS_ROLES, "business", "x").unwrap_err().code, "FORBIDDEN_ROLE");
        assert_eq!(check_role(Some(&u("org_client", true)), SCHOOL_ROLES, "school", "x").unwrap_err().status, 403);
        assert!(check_role(Some(&u("admin", true)), BUSINESS_ROLES, "business", "x").is_ok());
        assert_eq!(pillar_for_role("teacher"), "school");
        assert_eq!(pillar_for_role("operator"), "business");
        assert_eq!(pillar_for_role("admin"), "core");
    }
}
