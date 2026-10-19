export function CredentialGuide() {
  return (
    <details>
      <summary>Which credential should I use?</summary>
      <dl>
        <dt>Platform login</dt>
        <dd>Used to manage this dashboard.</dd>
        <dt>Application session</dt>
        <dd>Used by signed-in users to call application APIs.</dd>
        <dt>Project API key</dt>
        <dd>Used by trusted code to call API-key-protected operations.</dd>
      </dl>
    </details>
  );
}
export function ApplicationLoginGuide() {
  return (
    <p>
      Signup creates an application account. Login returns an application
      session token. Where you store the token depends on your app architecture.
      Server-backed apps can keep it behind their own HttpOnly session. Tokens
      exposed to browser JavaScript must be protected against script injection.
    </p>
  );
}
