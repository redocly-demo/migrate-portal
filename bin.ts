import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import * as readline from 'node:readline';
import yaml from 'js-yaml';

type FsInfo = {
  list(pattern: RegExp): string[];
};

const fileRbacPermissions: Record<string, string> = {};
const partialFolders = new Set();
const apis: Record<string, any> = {};
const ignore: string[] = ['_*'];

const renamedFiles: Record<string, string> = {};

const defaultMigrationInstructions = `# Manual migration instructions

`;

let migrationInstructions = defaultMigrationInstructions;

const emptyOas = (title: string) => `openapi: 3.1.0
info:
  title: ${title}
  version: 1.0.0
  description: |
    {% admonition type="danger" name="Example file" %}
      This file was automatically generated and should be replaced with the actual OpenAPI definition.
      Please, connect remote content in Reunite.
    {% /admonition %}
paths: {}
`;

const PACKAGES = [
  '@redocly/realm',
  '@redocly/reef',
  '@redocly/revel',
  '@redocly/redoc',
  '@redocly/redoc-reef',
  '@redocly/redoc-revel',
  '@redocly/revel-reef',
];

migrate();

export async function migrate() {
  try {
    execSync('git diff --exit-code');
  } catch (e) {
    console.log(red('Please commit all changes before running the migration script'));
    process.exit(1);
  }

  let fsInfo = getFsInfo('.');

  await migratePackageJson();
  await migrateOpenAPI(fsInfo);
  migrateMdx(fsInfo);

  fsInfo = getFsInfo('.'); // get fsInfo again after migrating mdx files
  migrateMarkdown(fsInfo);
  migrateSidebars(fsInfo);
  migrateConfig();
  migrateOverrides();
  migrateTheme();

  runNpmInstall();

  console.log(green('\n\n🎉 Migration completed successfully'));
  if (migrationInstructions !== defaultMigrationInstructions) {
    console.log(`⚠️ There are some manual steps required, see ${blue('_MIGRATION.md')}.`);
    migrationInstructions += `\n## After migration\n\n` + `Remove this \`_MIGRATION.md\` file after migration.`;
    fs.writeFileSync('_MIGRATION.md', migrationInstructions);
  }
  console.log('Please, review the changes and commit them.');
}

function runNpmInstall() {
  console.log('→ Running npm install');
  if (fs.existsSync('yarn.lock')) fs.unlinkSync('yarn.lock');
  if (fs.existsSync('package-lock.json')) fs.unlinkSync('package-lock.json');
  execSync('npm install', { stdio: 'inherit' });
}

function migrateMarkdown(fsInfo: FsInfo) {
  console.log('→ Migrating markdown files');
  const markdownFiles = fsInfo.list(/\.md$/);
  if (markdownFiles.length === 0) {
    return;
  }

  for (const filePath of markdownFiles) {
    const content = fs.readFileSync(filePath, 'utf8');

    const admonitionRegex = /:::(\w+)(?: +(.+?)\n|\s*\n)([\s\S]+?)(:::|$)/g;
    let newContent = content.replace(admonitionRegex, (_, type, title, text) => {
      type = type.trim();
      type = type === 'attention' ? 'info' : type;
      text = text.endsWith('\n') ? text : text + '\n';
      return `{% admonition type="${type}" name="${title}" %}\n${text}{% /admonition %}`;
    });

    const embedRegex = /<embed\s+src="(.*?)"\s+\/>/g;
    newContent = newContent.replace(embedRegex, (_, src) => {
      if (src.startsWith('/')) {
        partialFolders.add(path.dirname(src.slice(1)));
      } else {
        partialFolders.add(path.dirname(path.resolve(path.dirname(filePath), src)));
      }
      return `{% partial file="${src}" /%}`;
    });

    newContent = newContent.replace(/```(\w+)?\s+(.+)\n([\s\S]+?)```/g, '```$1 {% title="$2" %}\n$3```');

    const { frontmatter, changed, len } = processFrontMatter(newContent, filePath);

    if (changed) {
      if (Object.keys(frontmatter || {}).length === 0) {
        newContent = newContent.slice(len);
      } else {
        newContent = `---\n${yaml.dump(frontmatter)}---\n\n${newContent.slice(len)}`;
      }
    }

    // replace links to renamed files
    newContent = newContent.replace(/(\[[^\]]+\]\()([^)]+)(\))/g, (_, start, link, end) => {
      const [fileLink, hash] = link.split('#');
      const hashSuffix = hash ? '#' + hash : '';
      const relativeLink = path.relative(
        '.',
        fileLink.startsWith('/') ? fileLink.slice(1) : path.resolve(path.dirname(filePath), fileLink)
      );

      if (renamedFiles[relativeLink]) {
        return start + path.relative(path.dirname(filePath), renamedFiles[relativeLink]) + hashSuffix + end;
      }

      // migrate some openapi docs links
      const isRefLink =
        Object.keys(renamedFiles).some(f => {
          if (f.endsWith('.page.yaml')) {
            const routeSlug = slugRoute(f.replace('.page.yaml', ''));

            if (link.startsWith('/' + routeSlug + '/')) {
              return true;
            }
          }
        }) && link.includes('/tag/');

      if (isRefLink) {
        return start + link.replace('/tag/', '/').toLowerCase() + end;
      }

      return _;
    });

    if (newContent !== content) {
      fs.writeFileSync(filePath, newContent);
    }
  }
}

function migrateSidebars(fsInfo: FsInfo) {
  console.log('→ Migrating sidebars files');
  const sidebars = fsInfo.list(/sidebars\.yaml$/);
  if (sidebars.length === 0) {
    return;
  }

  for (const filePath of sidebars) {
    const content = fs.readFileSync(filePath, 'utf8');
    const data = yaml.load(content);
    if (typeof data !== 'object' || data === null) {
      return;
    }

    if (Array.isArray(data)) {
      const newData = transformSidebarItems(data, filePath);
      if (!dequal(data, newData)) {
        fs.writeFileSync(filePath, yaml.dump(newData));
      }
    } else {
      Object.entries(data).forEach(([key, data], idx) => {
        const newData = transformSidebarItems(data, filePath);
        const prefix = idx === 0 ? '' : slug(key) + '.';
        const newName = prefix + 'sidebars.yaml';
        if (!dequal(data, newData)) {
          fs.writeFileSync(path.join(path.dirname(filePath), newName), yaml.dump(newData));
        }
      });
    }
  }

  function transformSidebarItems(items: any[], filePath: string): any {
    return items.map((item: any) => {
      // check for renamed files (page.yaml and mdx)

      if (item.pages) {
        return {
          ...item,
          pages: undefined,
          items: transformSidebarItems(item.pages, filePath),
        };
      } else {
        if (item.page?.endsWith('/*')) {
          if (item.page.endsWith('.page.yaml/*')) {
            const pageYamlFile = path.relative('.', path.resolve(path.dirname(filePath), item.page.replace('/*', '')));
            if (!renamedFiles[pageYamlFile]) {
              throw new Error(`No renamed file found for ${pageYamlFile}`);
            }
            return {
              ...item,
              page: path.relative(path.dirname(filePath), renamedFiles[pageYamlFile]),
            };
          } else {
            return {
              ...item,
              page: undefined,
              directory: item.page.slice(0, -2),
            };
          }
        }
        if (item.page?.endsWith('.page.yaml')) {
          const pageYamlFile = path.relative('.', path.resolve(path.dirname(filePath), item.page.replace('/*', '')));
          if (!renamedFiles[pageYamlFile]) {
            throw new Error(`No renamed file found for ${pageYamlFile}`);
          }
          return {
            ...item,
            group: item.label || item.group,
            page: path.relative(path.dirname(filePath), renamedFiles[pageYamlFile]),
          };
        }

        if (item.page) {
          const relativeLink = path.relative('.', path.resolve(path.dirname(filePath), item.page));
          if (renamedFiles[relativeLink]) {
            return {
              ...item,
              page: path.relative(path.dirname(filePath), renamedFiles[relativeLink]),
            };
          }
        }

        return item;
      }
    });
  }
}

async function migratePackageJson() {
  console.log('→ Migrating package.json');
  const packageJsonPath = path.resolve('package.json');
  if (!fs.existsSync(packageJsonPath)) {
    console.log('No package.json found. Ensure that you run the migration script from the root of the project');
    process.exit(1);
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (!packageJson.dependencies || !packageJson.dependencies['@redocly/developer-portal']) {
    console.log(
      'No @redocly/developer-portal dependency found in package.json. Ensure that you run the migration script from the root of the project'
    );
    process.exit(1);
  }

  delete packageJson.dependencies['@redocly/developer-portal'];

  console.log(`Pick the ${blue('product')} you want to migrate to:`);
  console.log(PACKAGES.map((p, idx) => `${idx + 1}) ${p}`).join('\n'));
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let choice = -1;
  do {
    choice = parseInt(await new Promise(resolve => rl.question('Enter the number of the product: ', resolve)));
  } while (isNaN(choice) || choice < 1 || choice > PACKAGES.length);

  rl.close();

  const product = PACKAGES[choice - 1];
  const version = execSync(`npm show ${product} version`).toString().trim();

  packageJson.dependencies[product] = version;
  if (packageJson.scripts) {
    if (packageJson.scripts['start']) {
      packageJson.scripts['start'] = packageJson.scripts['start'].includes('redocly-portal')
        ? packageJson.scripts['start'].replace('redocly-portal develop', 'npx @redocly/cli preview')
        : 'npx @redocly/cli preview';
    }
    if (packageJson.scripts['build'] && packageJson.scripts['build'].includes('redocly-portal')) {
      delete packageJson.scripts['build'];
    }
    if (packageJson.scripts['clean'] && packageJson.scripts['clean'].includes('redocly-portal')) {
      delete packageJson.scripts['clean'];
    }
  }

  if (fs.existsSync('index.mdx')) {
    packageJson.dependencies['@redocly/portal-legacy-ui'] = '^0.1.0';
  }

  if (Object.keys(packageJson.dependencies).length === 1) {
    delete packageJson.overrides;
    delete packageJson.resolutions;
  }

  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
}

async function migrateOpenAPI(fsInfo: FsInfo) {
  console.log('→ Migrating OpenAPI files');
  const pageYamlFiles = fsInfo.list(/\.page\.yaml$/);

  const siteConfig = yaml.load(fs.readFileSync('siteConfig.yaml', 'utf8')) as Record<string, any>;

  const oasDefinitions = siteConfig?.oasDefinitions || {};

  let addedRegistryRecord = false;

  for (const filePath of pageYamlFiles) {
    const pageYaml = yaml.load(fs.readFileSync(filePath, 'utf8')) as Record<string, any>;
    fs.unlinkSync(filePath);
    if (pageYaml.versions && pageYaml.versions.length > 1) {
      for (const version of pageYaml.versions) {
        const definitionId = version.definitionId;
        if (!definitionId) {
          console.log(`No definitionId found for ${filePath}`);
          continue;
        }

        const renamed = await migratePageYaml(
          definitionId,
          version,
          path.join(path.dirname(filePath), path.basename(filePath, '.page.yaml'), '@' + version.id, 'index.yaml'),
          true
        );
        if (renamed) renamedFiles[path.normalize(filePath)] = renamed;
      }
    } else {
      const definitionId = pageYaml.definitionId || pageYaml.versions?.[0]?.definitionId;
      if (!definitionId) {
        console.log(`No definitionId found for ${filePath}`);
        continue;
      }

      const renamed = await migratePageYaml(definitionId, pageYaml, filePath.replace('.page.yaml', '.yaml'), false);
      if (renamed) renamedFiles[path.normalize(filePath)] = renamed;
    }
  }

  async function migratePageYaml(definitionId: string, pageYaml: any, targetPath: string, versioned: boolean) {
    const definitionPath = oasDefinitions[definitionId];
    if (!definitionPath) {
      console.log(`No definition path found for ${definitionId}`);
      return;
    }

    if (definitionPath.match(/https?:\/\//)) {
      const dir = versioned
        ? path.dirname(targetPath)
        : path.join(path.dirname(targetPath), path.basename(targetPath, '.yaml'));

      fs.mkdirSync(dir, {
        recursive: true,
      });

      const definitionInfo = await tryFetchRemoteDefinition(definitionPath);

      const newTargetPath = path.join(dir, definitionInfo?.baseName || path.basename(definitionPath));

      apis[definitionId] = {
        ...apis[definitionId],
        root: newTargetPath,
        output: path.join(dir, 'index.yaml'),
      };

      fs.writeFileSync(
        newTargetPath,
        definitionInfo?.text || emptyOas(pageYaml.title || pageYaml.label || definitionId)
      );

      if (definitionInfo?.readme) {
        if (!addedRegistryRecord) {
          migrationInstructions += `## Registry OpenAPI files\n\n`;
          migrationInstructions +=
            'OpenAPI files from registry has to be replaced with [Remote content](https://redocly.com/docs/realm/setup/how-to/remote-content)\n\n';
          addedRegistryRecord = true;
        }
        migrationInstructions += `* Connect folder \`${dir}\`:\n` + `${definitionInfo.readme}\n`;
      }

      if (pageYaml.permission) {
        fileRbacPermissions[path.relative('.', newTargetPath)] = pageYaml.permission;
      }
      return newTargetPath;
    } else {
      fs.renameSync(definitionPath, targetPath);
      if (pageYaml.settings) {
        apis[definitionId] = {
          root: path.relative('.', targetPath),
          theme: {
            openapi: migrateRefDocsSettings(pageYaml.settings),
          },
        };
      }

      if (pageYaml.permission) {
        fileRbacPermissions[path.relative('.', targetPath)] = pageYaml.permission;
      }
      return targetPath;
    }
  }

  function migrateRefDocsSettings(settings: any) {
    return {
      ...settings,
      codeSamples: settings.generateCodeSamples,
      generateCodeSamples: undefined,
      pagination: undefined,
      // FIXME
    };
  }
}

function migrateTheme() {
  migrationInstructions +=
    `\n## Theme\n\n` +
    `Migrate theme settings manually: https://redocly.com/docs/realm/get-started/migrate-from-legacy-portal#migrate-theme\n\n` +
    `Remove the \`theme.ts\` file after migration.\n`;
}

// @ts-ignore
function migrateRbac() {
  // TODO
}

function migrateConfig() {
  const siteConfig = yaml.load(fs.readFileSync('siteConfig.yaml', 'utf8')) as Record<string, any>;

  if (siteConfig.apiCatalog) {
    migrationInstructions +=
      `## API Catalog\n\n` +
      `Please, migrate API catalog manually: https://redocly.com/docs/realm/get-started/migrate-from-legacy-portal#new-api-catalog-format\n\n`;
  }

  const tocDepth = siteConfig.toc?.maxDepth || siteConfig.tocMaxDepth || undefined;
  const tocHide = !siteConfig.toc?.enable === false ? undefined : true;

  const config = {
    requiresLogin: true,
    reunite:
      !siteConfig.linkChecker?.severity || siteConfig.linkChecker?.severity === 'warning'
        ? {
            ignoreMarkdocErrors: true,
            ignoreLinkChecker: true,
          }
        : undefined,
    apis,
    seo: siteConfig.seo || undefined,
    ignore,
    links: siteConfig.stylesheets
      ? siteConfig.stylesheets.map((l: string) => ({
          rel: 'stylesheet',
          href: l,
        }))
      : undefined,
    scripts:
      siteConfig.scripts || siteConfig.postBodyScripts
        ? {
            head: siteConfig.scripts ? siteConfig.scripts.map((s: string) => ({ src: s })) : undefined,
            body: siteConfig.postBodyScripts ? siteConfig.postBodyScripts.map((s: string) => ({ src: s })) : undefined,
          }
        : undefined,
    navbar: migrateNavbar(siteConfig),
    footer: migrateFooter(siteConfig),
    search: siteConfig.nav?.some((i: any) => i.search) ? undefined : { hide: true },
    analytics: siteConfig.analytics,
    codeSnippet: siteConfig.copyCodeSnippet
      ? {
          copy: {
            hide: !siteConfig.copyCodeSnippet.enable,
          },
        }
      : undefined,
    markdown: {
      partialsFolders: partialFolders.size > 0 ? Array.from(partialFolders) : undefined,
      lastUpdatedBlock: siteConfig.disableLastModified
        ? {
            hide: true,
          }
        : undefined,
      editPage: siteConfig.editPage
        ? {
            baseUrl: siteConfig.editPage.baseUrl,
          }
        : undefined,
      toc:
        tocDepth !== undefined || tocHide
          ? {
              depth: tocDepth,
              hide: tocHide,
            }
          : undefined,
    },
    logo: siteConfig.logo
      ? typeof siteConfig.logo === 'string'
        ? {
            image: siteConfig.logo,
            link: '/',
          }
        : {
            link: '/',
            ...siteConfig.logo,
          }
      : undefined,
    navigation:
      siteConfig.showNextButton === false || siteConfig.showPrevButton === false
        ? {
            nextButton: { hide: !siteConfig.showNextButton },
            previousButton: { hide: !siteConfig.showPrevButton },
          }
        : undefined,
  };

  fs.writeFileSync(
    'redocly.yaml',
    '# Project requires login by default. Remove the next line if you want it to be public.\n' + yaml.dump(config)
  );

  fs.unlinkSync('siteConfig.yaml');

  function migrateNavbar(siteConfig: any) {
    return {
      items: siteConfig.nav?.filter((i: any) => !i.search),
    };
  }

  function migrateFooter(siteConfig: any) {
    if (!siteConfig.footer) return undefined;
    return {
      items: siteConfig.footer.columns || undefined,
      copyrightText: siteConfig.footer.copyrightText,
    };
  }
}

function migrateMdx(fsInfo: FsInfo) {
  console.log('→ Migrating MDX files');
  const mdxFiles = fsInfo.list(/\.mdx$/);
  if (mdxFiles.length === 0) {
    return;
  }

  migrationInstructions += `## MDX files\n\n` + `Please, review and migrate MDX files manually:\n\n`;

  for (const filePath of mdxFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    switch (detectMdxType(content)) {
      case 'md':
        convertMdxToMd(content, filePath);
        break;
      case 'tsx':
        convertMdxToTsx(content, filePath);
        break;
    }
    migrationInstructions += `* \`${path.relative('.', filePath)}\`\n`;
  }

  function detectMdxType(content: string): 'md' | 'tsx' {
    if (content.match(/^#+\s*\w/m)) {
      return 'md';
    }
    return 'tsx';
  }

  function convertMdxToTsx(content: string, filePath: string) {
    const newFilePath = filePath.replace(/\.mdx$/, '.page.tsx');
    const { frontmatter, len } = processFrontMatter(content, newFilePath);
    const newContent = content.slice(len);

    const frontmatterStr = frontmatter
      ? `\n\nexport const frontmatter = ${JSON.stringify(frontmatter, null, 2)};\n\n`
      : '';

    // TODO: improve
    fs.writeFileSync(
      newFilePath,
      `import * as React from 'react';\n\n` +
        `// import { WideTile, Jumbotron } from '@redocly/portal-legacy-ui';\n\n` +
        `${frontmatterStr}` +
        `export default function Page() {\n` +
        `  return <div>TODO: migrate manually</div>;\n` +
        `  /*\n` +
        newContent
          .split('\n')
          .map(line => `  ${line}`)
          .join('\n') +
        `  */\n` +
        `}\n`
    );
    fs.unlinkSync(filePath);
    renamedFiles[path.normalize(filePath)] = newFilePath;
  }

  function convertMdxToMd(content: string, filePath: string) {
    const newFilePath = filePath.replace(/\.mdx$/, '.md');
    const { frontmatter, len } = processFrontMatter(content, newFilePath);
    const newContent = content.slice(len);

    const frontmatterStr =
      frontmatter && Object.keys(frontmatter).length > 0 ? `---\n${yaml.dump(frontmatter)}---\n\n` : '';

    const banner = `<!--\nThis file was automatically renamed from MDX to Markdown.\nPlease, review and update the content.\n-->\n\n`;

    fs.writeFileSync(newFilePath, `${frontmatterStr}${banner}${newContent}`);
    fs.unlinkSync(filePath);
    renamedFiles[path.normalize(filePath)] = newFilePath;
  }
}

function migrateOverrides() {
  if (fs.existsSync('_overrides')) {
    migrationInstructions +=
      `## \`_overrides\` folder\n\n` + `Please, migrate \`_overrides\` folder manually if needed.\n\n`;
  }
}

function slug(str: string) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function slugRoute(str: string) {
  return str.split('/').map(slug).join('/');
}

function getFsInfo(contentDir: string): FsInfo {
  const files: string[] = [];

  function readdirDeep(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'public') {
          continue;
        }
        readdirDeep(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  }

  readdirDeep(contentDir);

  return {
    list(pattern: RegExp) {
      return files.filter(file => file.match(pattern));
    },
  };
}

const has = Object.prototype.hasOwnProperty;

export function dequal(foo: any, bar: any) {
  let ctor, len;
  if (foo === bar) return true;

  if (foo && bar && (ctor = foo.constructor) === bar.constructor) {
    // @ts-ignore
    if (ctor === Date) return foo.getTime() === bar.getTime();
    if (ctor === RegExp) return foo.toString() === bar.toString();

    if (ctor === Array) {
      if ((len = foo.length) === bar.length) {
        while (len-- && dequal(foo[len], bar[len]));
      }
      return len === -1;
    }

    if (!ctor || typeof foo === 'object') {
      len = 0;
      // @ts-ignore
      for (ctor in foo) {
        // @ts-ignore
        if (has.call(foo, ctor) && ++len && !has.call(bar, ctor)) return false;
        // @ts-ignore
        if (!(ctor in bar) || !dequal(foo[ctor], bar[ctor])) return false;
      }
      return Object.keys(bar).length === len;
    }
  }

  return foo !== foo && bar !== bar;
}

function processFrontMatter(content: string, filePath: string) {
  const frontMatterSrc = content.match(/^---\r?\n([\s\S]+?)\r?\n---(?:\r?\n)+/);
  if (!frontMatterSrc) return { frontmatter: null, changed: false };

  let changed = false;
  const frontMatterYaml = frontMatterSrc[1].replaceAll('\t', '  ');
  const frontmatter = yaml.load(frontMatterYaml) as Record<string, any>;
  if (frontmatter.permission) {
    fileRbacPermissions[filePath] = frontmatter.permission;
    delete frontmatter.permission;
    changed = true;
  }
  if (frontmatter.redirectFrom) {
    frontmatter.redirects = frontmatter.redirectFrom.reduce((acc: Record<string, any>, str: string) => {
      acc[str] = {};
      return acc;
    }, {});
    delete frontmatter.redirectFrom;
    changed = true;
  }

  if (frontmatter.exclude) {
    ignore.push(filePath);
  }
  return { changed, frontmatter, len: frontMatterSrc[0].length };
}

let token: string | null = null;

async function tryFetchRemoteDefinition(definitionPath: string) {
  if (token === null) {
    console.log(`Detected APIs from ${blue('API registry')}. They need to be replaced with remote content.`);
    console.log('Enter your organization API Key.\n');
    token = await hiddenQuestion('> ');
  }

  if (token === '') {
    console.log('Skipping download of remote OpenAPI file');
    return null;
  }

  if (token) {
    const baseURL = definitionPath.split('/registry')[0];
    const parts = definitionPath.slice(baseURL.length).split('/');
    const orgId = decodeURIComponent(parts[3]);
    const definitionName = decodeURIComponent(parts[4]);
    const versionName = decodeURIComponent(parts[5]);

    const body = JSON.stringify({
      query:
        'query GetSourceDetails($orgId: String!, $definitionName: String!, $versionName: String!) {\n    def: definitionVersionByOrganizationDefinitionAndName(\n        organizationId: $orgId,\n        definitionName: $definitionName,\n        versionName: $versionName\n    ) {\n        id\n        source\n        sourceType\n    }\n}',
      variables: {
        orgId,
        definitionName,
        versionName,
      },
    });

    const details = await fetch(`${baseURL}/graphql`, {
      method: 'POST',
      headers: {
        Authorization: `${token}`,
        'Content-Type': 'application/json',
      },
      body,
    }).then(res => res.json());

    if (!details.data?.def) {
      console.log('Failed to fetch remote OpenAPI file details', details);
      return null;
    }

    const source = JSON.parse(details.data.def.source);
    const rootFile = source.rootFile;
    const dirName = path.dirname(source.rootFile);
    const baseName = path.basename(rootFile);

    let readme = '';
    if (details.data.def.sourceType === 'URL') {
      readme += `Connect remote file [from URL](https://redocly.com/docs/realm/setup/how-to/remote-content/url): \`${source.url}\`.\n`;
    } else if (details.data.def.sourceType === 'CICD') {
      readme += `Connect remote content from [CI/CD pipeline](https://redocly.com/docs/realm/setup/how-to/remote-content/push).`;
    } else {
      const link =
        {
          GH: 'https://redocly.com/docs/realm/setup/how-to/remote-content/from-github',
          GH_ENTERPRISE: 'https://redocly.com/docs/realm/setup/how-to/remote-content/from-github',
          GITLAB: 'https://redocly.com/docs/realm/setup/how-to/remote-content/from-gitlab',
          GITLAB_HOSTED: 'https://redocly.com/docs/realm/setup/how-to/remote-content/from-gitlab-self-managed',
          AZURE: 'https://redocly.com/docs/realm/setup/how-to/remote-content/from-azure-devops',
        }[details.data.def.sourceType as string] ||
        'https://redocly.com/docs/realm/setup/how-to/remote-content/from-github';

      readme +=
        `Connect remote content from [${details.data.def.sourceType} repository](${link}).` +
        `    Pick \`${source.login}/${source.repo}\` repository and select \`${dirName}\` folder`;
    }

    if (readme) {
      readme = `  1. In Reunite, delete the folder.\n  2. ` + readme;
    }

    return fetch(definitionPath, {
      redirect: 'manual',

      headers: {
        Authorization: `${token}`,
      },
    })
      .then(res => {
        if ((res.status === 301 || res.status === 302 || res.status === 403 || res.status === 502) && token !== null) {
          token = '';
          console.log('Invalid token provided. Skipping download of remote OpenAPI files');
        }
        if (res.ok) {
          return res.text();
        }
        return null;
      })
      .then(text => {
        return { text, readme, baseName };
      });
  }
}

function hiddenQuestion(query: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const stdin = process.openStdin();
    process.stdin.on('data', (char: string) => {
      char = char + '';
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004':
          stdin.pause();
          break;
        default:
          process.stdout.clearLine(-1);
          readline.cursorTo(process.stdout, 0);
          const len = Math.min(process.stdout.columns - query.length - 2, rl.line.length);
          process.stdout.write(query + (rl.line.length > 1 ? '*'.repeat(len) : ''));
          break;
      }
    });
    rl.question(query, value => {
      (rl as any).history = (rl as any).history.slice(1);
      resolve(value);
    });
  });
}

function blue(text: string) {
  return `\x1b[34m${text}\x1b[0m`;
}

function green(text: string) {
  return `\x1b[32m${text}\x1b[0m`;
}

function red(text: string) {
  return `\x1b[31m${text}\x1b[0m`;
}
