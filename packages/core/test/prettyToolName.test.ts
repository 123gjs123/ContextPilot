import { describe, expect, it } from 'vitest';
import { prettyToolName } from '../src/index.js';

describe('prettyToolName', () => {
  it('abrevia herramientas MCP a «servidor › herramienta»', () => {
    expect(prettyToolName('mcp__claude_ai_Atlassian_Rovo__searchJiraIssuesUsingJql')).toBe('Atlassian Rovo › searchJiraIssuesUsingJql');
    expect(prettyToolName('mcp__github__create_issue')).toBe('github › create_issue');
  });
  it('deja igual las herramientas nativas', () => {
    expect(prettyToolName('Bash')).toBe('Bash');
  });
});
