import { readFileSync, readdirSync, existsSync } from "fs";
import path from "path";

// Directories where Claude Code skills live
const SKILL_DIRS = [
  "/home/xavier/.claude/skills",
  "/home/xavier/.openclaw/workspace/skills",
  "/home/xavier/xklip/disclawd/skills",
];

export interface SkillDef {
  name: string;
  description: string;
  content: string; // full markdown content (without frontmatter)
  path: string;
  references: string[]; // paths to reference files
}

// Cache — reload on demand
let skillCache: Map<string, SkillDef> | null = null;

/**
 * Discover all available skills from known directories.
 */
export function discoverSkills(): Map<string, SkillDef> {
  const skills = new Map<string, SkillDef>();

  for (const dir of SKILL_DIRS) {
    if (!existsSync(dir)) continue;

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillPath = path.join(dir, entry.name, "SKILL.md");
        if (!existsSync(skillPath)) continue;

        try {
          const raw = readFileSync(skillPath, "utf-8");
          const { frontmatter, content } = parseFrontmatter(raw);

          const name = frontmatter.name || entry.name;
          const description = frontmatter.description || "";

          // Find reference files
          const refsDir = path.join(dir, entry.name, "references");
          const references: string[] = [];
          if (existsSync(refsDir)) {
            const refFiles = readdirSync(refsDir).filter(f => f.endsWith(".md"));
            for (const ref of refFiles) {
              references.push(path.join(refsDir, ref));
            }
          }

          skills.set(name, { name, description, content, path: skillPath, references });
        } catch {
          // Skip broken skill files
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  skillCache = skills;
  return skills;
}

/**
 * Get all skills (cached).
 */
export function getAllSkills(): Map<string, SkillDef> {
  if (!skillCache) return discoverSkills();
  return skillCache;
}

/**
 * Reload skills from disk.
 */
export function reloadSkills(): Map<string, SkillDef> {
  skillCache = null;
  return discoverSkills();
}

/**
 * Get specific skills by name.
 */
export function getSkills(names: string[]): SkillDef[] {
  const all = getAllSkills();
  return names.map(n => all.get(n)).filter((s): s is SkillDef => !!s);
}

/**
 * Build a system prompt injection from skill definitions.
 * Includes the skill content + condensed reference material.
 */
export function buildSkillPrompt(skillNames: string[]): string {
  const skills = getSkills(skillNames);
  if (skills.length === 0) return "";

  const sections: string[] = [];

  for (const skill of skills) {
    let section = `## Skill: ${skill.name}\n\n${skill.content}`;

    // Add reference content (condensed — first 2000 chars per ref, max 3 refs)
    const refsToInclude = skill.references.slice(0, 3);
    for (const refPath of refsToInclude) {
      try {
        const refContent = readFileSync(refPath, "utf-8");
        const refName = path.basename(refPath, ".md");
        const truncated = refContent.length > 2000
          ? refContent.slice(0, 2000) + "\n[...truncated]"
          : refContent;
        section += `\n\n### Reference: ${refName}\n${truncated}`;
      } catch {}
    }

    sections.push(section);
  }

  return `\n\n# Skills disponibles\n\n${sections.join("\n\n---\n\n")}`;
}

/**
 * List all available skill names with descriptions.
 */
export function listSkills(): { name: string; description: string; path: string }[] {
  const all = getAllSkills();
  return Array.from(all.values()).map(s => ({
    name: s.name,
    description: s.description.slice(0, 120),
    path: s.path,
  }));
}

/**
 * Parse YAML-ish frontmatter from a markdown file.
 * Simple parser — handles name: value pairs between --- delimiters.
 */
function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; content: string } {
  const fm: Record<string, string> = {};

  if (!raw.startsWith("---")) {
    return { frontmatter: fm, content: raw };
  }

  const endIdx = raw.indexOf("---", 3);
  if (endIdx === -1) {
    return { frontmatter: fm, content: raw };
  }

  const fmBlock = raw.slice(3, endIdx).trim();
  const content = raw.slice(endIdx + 3).trim();

  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fm[key] = value;
  }

  return { frontmatter: fm, content };
}
