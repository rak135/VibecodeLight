import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '../..');

describe('README LM Studio configuration docs', () => {
  test('documents LM Studio as a Live provider with its config keys and env var', () => {
    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

    // Provider config contract: key, label, base URL, and env var name.
    expect(readme).toContain('lmstudio:');
    expect(readme).toContain('label: LM Studio');
    expect(readme).toContain('base_url: http://127.0.0.1:1234/v1');
    expect(readme).toContain('api_key_env: LMSTUDIO_API_KEY');
  });
});
