#!/usr/bin/env npx tsx
/**
 * Install Skill Dependencies
 *
 * Scans all skill directories for requirements.txt files and installs
 * them into the configured Python/conda environment.
 *
 * Usage:
 *   npm run install-skills
 *   npx tsx scripts/install-skill-deps.ts
 *   npx tsx scripts/install-skill-deps.ts --dry-run
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ES module compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const SKILLS_DIR = path.join(__dirname, '..', 'skills', 'builtin');
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');

interface SkillDependency {
  skillName: string;
  requirementsPath: string;
  content: string;
}

/**
 * Find all requirements.txt files in skill directories
 */
function findRequirementsFiles(): SkillDependency[] {
  const dependencies: SkillDependency[] = [];
  
  if (!fs.existsSync(SKILLS_DIR)) {
    console.error(`Skills directory not found: ${SKILLS_DIR}`);
    return dependencies;
  }
  
  const skillDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);
  
  for (const skillName of skillDirs) {
    const requirementsPath = path.join(SKILLS_DIR, skillName, 'requirements.txt');
    
    if (fs.existsSync(requirementsPath)) {
      const content = fs.readFileSync(requirementsPath, 'utf-8');
      dependencies.push({
        skillName,
        requirementsPath,
        content
      });
      
      if (VERBOSE) {
        console.log(`\nFound requirements for ${skillName}:`);
        console.log(`  Path: ${requirementsPath}`);
      }
    }
  }
  
  return dependencies;
}

/**
 * Get the Python/conda environment configuration
 */
function getPythonConfig(): { useConda: boolean; condaEnv?: string; pythonCmd: string } {
  // Load .env file if it exists
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const condaEnvMatch = envContent.match(/CONDA_ENV_NAME=(.+)/);
    if (condaEnvMatch && condaEnvMatch[1]) {
      const condaEnv = condaEnvMatch[1].trim().replace(/['"]/g, '');
      return { useConda: true, condaEnv, pythonCmd: `conda run -n ${condaEnv} pip` };
    }
  }
  
  // Check environment variables
  const condaEnv = process.env.CONDA_ENV_NAME;
  if (condaEnv) {
    return { useConda: true, condaEnv, pythonCmd: `conda run -n ${condaEnv} pip` };
  }
  
  return { useConda: false, pythonCmd: 'pip3' };
}

/**
 * Install dependencies from a requirements.txt file
 */
function installDependencies(dep: SkillDependency, pythonCmd: string): boolean {
  console.log(`\n📦 Installing dependencies for ${dep.skillName}...`);
  
  if (VERBOSE) {
    console.log('Requirements:');
    const lines = dep.content.split('\n')
      .filter(line => line.trim() && !line.startsWith('#'));
    for (const line of lines) {
      console.log(`  - ${line}`);
    }
  }
  
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would run: ${pythonCmd} install -r ${dep.requirementsPath}`);
    return true;
  }
  
  try {
    const command = `${pythonCmd} install -r "${dep.requirementsPath}"`;
    console.log(`  Running: ${command}`);
    
    const output = execSync(command, {
      encoding: 'utf-8',
      stdio: VERBOSE ? 'inherit' : 'pipe'
    });
    
    console.log(`  ✅ Successfully installed dependencies for ${dep.skillName}`);
    return true;
  } catch (error) {
    console.error(`  ❌ Failed to install dependencies for ${dep.skillName}`);
    console.error(error);
    return false;
  }
}

/**
 * Main function
 */
function main() {
  console.log('🔧 Friday Skill Dependency Installer');
  console.log('=====================================\n');
  
  if (DRY_RUN) {
    console.log('🔍 DRY RUN MODE - No changes will be made\n');
  }
  
  // Find all requirements.txt files
  const dependencies = findRequirementsFiles();
  
  if (dependencies.length === 0) {
    console.log('No requirements.txt files found in skill directories.');
    return;
  }
  
  console.log(`Found ${dependencies.length} skill(s) with requirements:\n`);
  for (const dep of dependencies) {
    console.log(`  - ${dep.skillName}: ${dep.requirementsPath}`);
  }
  
  // Get Python configuration
  const config = getPythonConfig();
  console.log(`\n🐍 Python Configuration:`);
  console.log(`  Use Conda: ${config.useConda}`);
  if (config.useConda && config.condaEnv) {
    console.log(`  Conda Environment: ${config.condaEnv}`);
  }
  console.log(`  Install Command: ${config.pythonCmd} install -r <requirements.txt>`);
  
  // Install each dependency
  let successCount = 0;
  let failCount = 0;
  
  for (const dep of dependencies) {
    if (installDependencies(dep, config.pythonCmd)) {
      successCount++;
    } else {
      failCount++;
    }
  }
  
  // Summary
  console.log('\n📊 Summary');
  console.log('===========');
  console.log(`  Total: ${dependencies.length}`);
  console.log(`  Success: ${successCount}`);
  console.log(`  Failed: ${failCount}`);
  
  if (failCount > 0) {
    console.log('\n⚠️  Some dependencies failed to install. Please check the errors above.');
    process.exit(1);
  }
  
  console.log('\n✅ All skill dependencies installed successfully!');
}

// Run
main();