#!/bin/bash
# Prepares the local development database (sqlite, ./.volumes) with the plugin
# migrated, Redmine's default data, a project with a wiki and a couple of users
# to collaborate with. Idempotent: safe to run again.

set -e

docker compose run --rm -e REDMINE_LANG=en redmine bin/rails db:migrate

# the dev Dockerfile overrides ENTRYPOINT, so the image's REDMINE_PLUGINS_MIGRATE
# auto-migration never runs and we have to do it explicitly here
docker compose run --rm -e REDMINE_LANG=en redmine bundle exec rake redmine:plugins:migrate NAME=redmine_realtime_editor RAILS_ENV=development

docker compose run --rm -e REDMINE_LANG=en redmine rake redmine:load_default_data

docker compose run --rm -e REDMINE_LANG=en redmine bin/rails runner -e development '
  admin = User.find_by(login: "admin")
  admin.update_columns(must_change_passwd: false)

  project = Project.find_by(identifier: "project1") || Project.create!(name: "project1", identifier: "project1")
  project.enabled_module_names = %w[issue_tracking wiki]
  project.trackers = Tracker.all
  project.save!
  project.wiki || Wiki.create!(project: project, start_page: "Wiki")

  role = Role.find_by(name: "Manager") || Role.givable.first
  Member.create!(project: project, user: admin, roles: [role]) unless Member.exists?(project_id: project.id, user_id: admin.id)

  [
    ["alice", "Alice", "Anderson"],
    ["bob",   "Bob",   "Brown"]
  ].each do |login, first, last|
    user = User.find_by(login: login) || User.new(login: login)
    user.firstname = first
    user.lastname = last
    user.mail = "#{login}@example.com"
    user.status = User::STATUS_ACTIVE
    user.must_change_passwd = false
    user.password = user.password_confirmation = "password123" if user.new_record?
    user.save!
    Member.create!(project: project, user: user, roles: [role]) unless Member.exists?(project_id: project.id, user_id: user.id)
  end

  unless Issue.exists?(project_id: project.id)
    Issue.create!(project: project, tracker: Tracker.first, author: admin, subject: "Collaborative editing demo",
                  description: "Open this issue in two browsers, click the pencil next to the description\nand type in both.\n",
                  priority: IssuePriority.default || IssuePriority.first, status: IssueStatus.sorted.first)
  end

  unless project.wiki.find_page("Wiki")
    page = WikiPage.new(wiki: project.wiki, title: "Wiki")
    page.content = WikiContent.new(text: "h1. Wiki\n\nEdit this page from two browsers at the same time.\n", author: admin)
    page.save!
  end
'
