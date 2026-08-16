# Access Control Policy

The plugin must refuse to read a note when the current user has not granted permission.
Every refusal is written to the audit trail so that an administrator can review it later.
Permissions are checked again whenever the workspace is reopened.
