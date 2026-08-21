-- DD-011 compatibility wrapper for the historical DD-008B database contract.
-- DD-008B predates MFA and intentionally tests RBAC/workstation behavior, not AAL.
-- Supply only the AAL claim at session scope; the included contract continues to
-- set its own auth.uid()/role fixtures and all data remains inside its transaction.

\set ON_ERROR_STOP on
set request.jwt.claims = '{"aal":"aal2"}';
\ir dd008b_auth_rbac_contract.sql
reset request.jwt.claims;
