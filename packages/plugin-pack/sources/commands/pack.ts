import {BaseCommand, WorkspaceRequiredError}                                                                        from '@yarnpkg/cli';
import {Cache, Configuration, MessageName, Project, StreamReport, Workspace, formatUtils, structUtils, ThrowReport} from '@yarnpkg/core';
import {Filename, npath, ppath, xfs}                                                                                from '@yarnpkg/fslib';
import {Command, Usage}                                                                                             from 'clipanion';

import * as packUtils                                                                                               from '../packUtils';

const outDescription = `Create the archive at the specified path`;

// eslint-disable-next-line arca/no-default-export
export default class PackCommand extends BaseCommand {
  @Command.Boolean(`--install-if-needed`, {description: `Run a preliminary \`yarn install\` if the package contains build scripts`})
  installIfNeeded: boolean = false;

  @Command.Boolean(`-n,--dry-run`, {description: `Print the file paths without actually generating the package archive`})
  dryRun: boolean = false;

  @Command.Boolean(`--json`, {description: `Format the output as an NDJSON stream`})
  json: boolean = false;

  @Command.String(`--filename`, {hidden: false, description: outDescription})
  @Command.String(`-o,--out`, {description: outDescription})
  out?: string;

  static usage: Usage = Command.Usage({
    description: `generate a tarball from the active workspace`,
    details: `
      This command will turn the active workspace into a compressed archive suitable for publishing. The archive will by default be stored at the root of the workspace (\`package.tgz\`).

      If the \`-o,---out\` is set the archive will be created at the specified path. The \`%s\` and \`%v\` variables can be used within the path and will be respectively replaced by the package name and version.
    `,
    examples: [[
      `Create an archive from the active workspace`,
      `yarn pack`,
    ], [
      `List the files that would be made part of the workspace's archive`,
      `yarn pack --dry-run`,
    ], [
      `Name and output the archive in a dedicated folder`,
      `yarn pack --out /artifacts/%s-%v.tgz`,
    ]],
  });

  @Command.Path(`pack`)
  async execute() {
    const configuration = await Configuration.find(this.context.cwd, this.context.plugins);
    const {project, workspace} = await Project.find(configuration, this.context.cwd);

    if (!workspace)
      throw new WorkspaceRequiredError(project.cwd, this.context.cwd);

    if (await packUtils.hasPackScripts(workspace)) {
      if (this.installIfNeeded) {
        await project.install({
          cache: await Cache.find(configuration),
          report: new ThrowReport(),
        });
      } else {
        await project.restoreInstallState();
      }
    }

    const target = typeof this.out !== `undefined`
      ? ppath.resolve(this.context.cwd, interpolateOutputName(this.out, {workspace}))
      : ppath.resolve(workspace.cwd, `package.tgz` as Filename);

    const report = await StreamReport.start({
      configuration,
      stdout: this.context.stdout,
      json: this.json,
    }, async report => {
      await packUtils.prepareForPack(workspace, {report}, async () => {
        report.reportJson({base: workspace.cwd});

        const files = await packUtils.genPackList(workspace);

        for (const file of files) {
          report.reportInfo(null, file);
          report.reportJson({location: file});
        }

        if (!this.dryRun) {
          const pack = await packUtils.genPackStream(workspace, files);
          const write = xfs.createWriteStream(target);

          pack.pipe(write);

          await new Promise(resolve => {
            write.on(`finish`, resolve);
          });
        }
      });

      if (!this.dryRun) {
        report.reportInfo(MessageName.UNNAMED, `Package archive generated in ${formatUtils.pretty(configuration, target, formatUtils.Type.PATH)}`);
        report.reportJson({output: target});
      }
    });

    return report.exitCode();
  }
}

function interpolateOutputName(name: string, {workspace}: {workspace: Workspace}) {
  const interpolated = name
    .replace(`%s`, prettyWorkspaceIdent(workspace))
    .replace(`%v`, prettyWorkspaceVersion(workspace));

  return npath.toPortablePath(interpolated);
}

function prettyWorkspaceIdent(workspace: Workspace) {
  if (workspace.manifest.name !== null) {
    return structUtils.slugifyIdent(workspace.manifest.name);
  } else {
    return `package`;
  }
}

function prettyWorkspaceVersion(workspace: Workspace) {
  if (workspace.manifest.version !== null) {
    return workspace.manifest.version;
  } else {
    return `unknown`;
  }
}
