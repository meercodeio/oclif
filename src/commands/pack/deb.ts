import {Command, flags} from '@oclif/command'
import * as Config from '@oclif/config'
import * as _ from 'lodash'
import * as qq from 'qqjs'

import * as Tarballs from '../../tarballs'

function debArch(arch: Config.ArchTypes) {
  if (arch === 'x64') return 'amd64'
  if (arch === 'x86') return 'i386'
  if (arch === 'arm') return 'armel'
  throw new Error(`invalid arch: ${arch}`)
}

const debVersion = (buildConfig: Tarballs.IConfig) => `${buildConfig.version.split('-')[0]}-1`

const scripts = {
  /* eslint-disable no-useless-escape */
  bin: (config: Config.IConfig) => `#!/usr/bin/env bash
set -e
echoerr() { echo "$@" 1>&2; }
get_script_dir () {
  SOURCE="\${BASH_SOURCE[0]}"
  # While \$SOURCE is a symlink, resolve it
  while [ -h "\$SOURCE" ]; do
    DIR="\$( cd -P "\$( dirname "\$SOURCE" )" && pwd )"
    SOURCE="\$( readlink "\$SOURCE" )"
    # If \$SOURCE was a relative symlink (so no "/" as prefix, need to resolve it relative to the symlink base directory
    [[ \$SOURCE != /* ]] && SOURCE="\$DIR/\$SOURCE"
  done
  DIR="\$( cd -P "\$( dirname "\$SOURCE" )" && pwd )"
  echo "\$DIR"
}
DIR=\$(get_script_dir)
export ${config.scopedEnvVarKey('UPDATE_INSTRUCTIONS')}="update with \\"sudo apt update && sudo apt install ${config.bin}\\""
\$DIR/node \$DIR/run "\$@"
`,
  /* eslint-enable no-useless-escape */
  control: (config: Tarballs.IConfig, arch: string) => `Package: ${config.config.bin}
Version: ${debVersion(config)}
Section: main
Priority: standard
Architecture: ${arch}
Maintainer: ${config.config.scopedEnvVar('AUTHOR') || config.config.pjson.author}
Description: ${config.config.pjson.description}
`,
  ftparchive: (config: Config.IConfig) => `
APT::FTPArchive::Release {
  Origin "${config.scopedEnvVar('AUTHOR') || config.pjson.author}";
  Suite  "stable";
`,
}

export default class PackDeb extends Command {
  static hidden = true

  static description = 'pack CLI into debian package'

  static flags = {
    root: flags.string({char: 'r', description: 'path to oclif CLI root', default: '.', required: true}),
  }

  async run() {
    if (process.platform !== 'linux') throw new Error('must be run from linux')
    const {flags} = this.parse(PackDeb)
    const buildConfig = await Tarballs.buildConfig(flags.root)
    const {config} = buildConfig
    await Tarballs.build(buildConfig, {platform: 'linux', pack: false})
    const dist = buildConfig.dist('deb')
    await qq.emptyDir(dist)
    const build = async (arch: Config.ArchTypes) => {
      const target: {platform: 'linux'; arch: Config.ArchTypes} = {platform: 'linux', arch}
      const versionedDebBase = `${config.bin}_${debVersion(buildConfig)}_${debArch(arch)}`
      const workspace = qq.join(buildConfig.tmp, 'apt', `${versionedDebBase}.apt`)
      await qq.rm(workspace)
      await qq.mkdirp([workspace, 'DEBIAN'])
      await qq.mkdirp([workspace, 'usr/bin'])
      await qq.mkdirp([workspace, 'usr/lib'])
      await qq.mv(buildConfig.workspace(target), [workspace, 'usr/lib', config.dirname])
      await qq.write([workspace, 'usr/lib', config.dirname, 'bin', config.bin], scripts.bin(config))
      await qq.write([workspace, 'DEBIAN/control'], scripts.control(buildConfig, debArch(arch)))
      await qq.chmod([workspace, 'usr/lib', config.dirname, 'bin', config.bin], 0o755)
      await qq.x(`ln -s "../lib/${config.dirname}/bin/${config.bin}" "${workspace}/usr/bin/${config.bin}"`)
      await qq.x(`chown -R root "${workspace}"`)
      await qq.x(`chgrp -R root "${workspace}"`)
      await qq.x(`dpkg --build "${workspace}" "${qq.join(dist, `${versionedDebBase}.deb`)}"`)
    }

    const arches = _.uniq(buildConfig.targets
    .filter(t => t.platform === 'linux')
    .map(t => t.arch))
    // eslint-disable-next-line no-await-in-loop
    for (const a of arches) await build(a)

    await qq.x('apt-ftparchive packages . > Packages', {cwd: dist})
    await qq.x('gzip -c Packages > Packages.gz', {cwd: dist})
    await qq.x('bzip2 -k Packages', {cwd: dist})
    await qq.x('xz -k Packages', {cwd: dist})
    const ftparchive = qq.join(buildConfig.tmp, 'apt', 'apt-ftparchive.conf')
    await qq.write(ftparchive, scripts.ftparchive(config))
    await qq.x(`apt-ftparchive -c "${ftparchive}" release . > Release`, {cwd: dist})
    const gpgKey = config.scopedEnvVar('DEB_KEY')
    if (gpgKey) {
      await qq.x(`gpg --digest-algo SHA512 --clearsign -u ${gpgKey} -o InRelease Release`, {cwd: dist})
      await qq.x(`gpg --digest-algo SHA512 -abs -u ${gpgKey} -o Release.gpg Release`, {cwd: dist})
    }
  }
}

