# This Chef task installs MongoDB in a new EC2 instance spun up by Kitchen in
# preparation for running some basic server functionality tests.

artifacts_tarball = 'artifacts.tgz'
homedir = "/tmp"

ruby_block 'allow sudo over tty' do
  block do
    file = Chef::Util::FileEdit.new('/etc/sudoers')
    file.search_file_replace_line(/Defaults\s+requiretty/, '#Defaults requiretty')
    file.search_file_replace_line(/Defaults\s+requiretty/, '#Defaults !visiblepw')
    file.write_file
  end
end

# This file limits processes to 1024. It therefore interfereres with `ulimit -u` when present.
if platform_family? 'rhel' or platform_family? 'amazon'
  file '/etc/security/limits.d/90-nproc.conf' do
    action :delete
  end
end

remote_file "#{homedir}/#{artifacts_tarball}" do
  source node['artifacts_url']
end

execute 'extract artifacts' do
  command "tar xzvf #{artifacts_tarball}"
  live_stream true
  cwd homedir
end

if platform_family? 'debian'

  # SERVER-40491 Debian 8 sources.list need to point to archive url
  if node['platform'] == 'debian' and node['platform_version'] == '8.1'
    cookbook_file '/etc/apt/sources.list' do
      source 'sources.list.debian8'
      owner 'root'
      group 'root'
      mode '0644'
      action :create
    end
  end

  execute 'apt update' do
    command 'apt update'
    live_stream true
  end

  ENV['DEBIAN_FRONTEND'] = 'noninteractive'
  package 'openssl'

  # the ubuntu image does not have some dependencies installed by default
  # and it is required for the install_compass script
  if node['platform'] == 'ubuntu' and node['platform_version'] >= '20.04'
    execute 'install dependencies ubuntu 20.04' do
      command 'apt-get install -y python3 libsasl2-modules-gssapi-mit'
      live_stream true
    end
    link '/usr/bin/python' do
      to '/usr/bin/python3'
    end
  else
    execute 'install dependencies' do
      command 'apt-get install -y python libsasl2-modules-gssapi-mit'
      live_stream true
    end
  end

  # dpkg returns 1 if dependencies are not satisfied, which they will not be
  # for enterprise builds. We install dependencies in the next block.
  execute 'install mongod' do
    command 'dpkg -i `find . -name "*server*.deb"`'
    live_stream true
    cwd homedir
    returns [0, 1]
  end

  # install the tools so we can test install_compass
  execute 'install mongo tools' do
    command 'dpkg -i `find . -name "*tools-extra*.deb"`'
    live_stream true
    cwd homedir
    returns [0, 1]
  end

  # yum and zypper fetch dependencies automatically, but dpkg does not.
  # Installing the dependencies explicitly is fragile, so we reply on apt-get
  # to install dependencies after the fact.
  execute 'update and fix broken dependencies' do
    command 'apt update && apt -y -f install'
    live_stream true
  end
end

if platform_family? 'rhel' or platform_family? 'amazon'
  bash 'wait for yum updates if they are running' do
    code <<-EOH
      sleep 120
    EOH
  end
  #rhel9 doesn't have Gconf2 without epel
  if node['platform'] == 'redhat' and node['platform_version'] == '9.0'
    execute 'install epel' do
      command 'dnf install https://dl.fedoraproject.org/pub/epel/epel-release-latest-9.noarch.rpm -y'
      live_stream true
      cwd homedir
    end
  end
  execute 'install mongod' do
    command 'yum install -y `find . -name "*server*.rpm"`'
    live_stream true
    cwd homedir
  end

  # install the tools so we can test install_compass
  execute 'install mongo tools' do
    command 'yum install -y `find . -name "*tools-extra*.rpm"`'
    live_stream true
    cwd homedir
  end
end

if platform_family? 'suse'
  bash 'wait for zypper lock to be released' do
    code <<-EOD
    retry_counter=0
    # We also need to make sure another instance of zypper isn't running while
    # we do our install, so just run zypper refresh until it doesn't fail.
    # Waiting for 2 minutes is copied from an internal project where we do this.
    until [ "$retry_counter" -ge "12" ]; do
        zypper refresh && exit 0
        retry_counter=$(($retry_counter + 1))
        [ "$retry_counter" = "12" ] && break
        sleep 10
    done
    exit 1
  EOD
  flags "-x"
  end

  execute 'install mongod' do
    command 'zypper --no-gpg-checks -n install `find . -name "*server*.rpm"`'
    live_stream true
    cwd homedir
  end

  execute 'install mongo tools' do
    command 'zypper --no-gpg-checks -n install `find . -name "*tools-extra*.rpm"`'
    live_stream true
    cwd homedir
  end
end
