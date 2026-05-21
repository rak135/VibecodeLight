test('invalid repo produces structured error suitable for UI display', async () => {
  const { resolveDesktopRepo } = await import('../../../src/app/desktop/repo_resolver.js');
  const result = resolveDesktopRepo({ repoArg: '/absolutely/nonexistent/path/xyz', cwd: process.cwd() });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  // Confirm it's a structured error, not a thrown exception
  expect(typeof result.error.code).toBe('string');
  expect(typeof result.error.message).toBe('string');
  expect(Array.isArray(result.error.details)).toBe(true);
  // Confirm the error does NOT say 'ENOENT' raw — it's human-readable
  expect(result.error.message).not.toMatch(/ENOENT/);
});
