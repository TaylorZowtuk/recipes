#!/usr/bin/env bash
# Removes the Docker leftovers of worktrees that no longer exist: the containers, volumes, networks
# and images of every recipes-* Compose project that no worktree of this repo has. A project with a
# running container is left alone. The shared recipes-cache volume is never touched.
set -euo pipefail
cd "$(dirname "$0")/.."

declare -A live=()
while read -r key path; do
  [[ $key == worktree ]] && live[$(scripts/project-name.sh "$path")]=1
done < <(git worktree list --porcelain)

pattern='^(recipes-.+-[0-9a-f]{7})(_node_modules|_venv|_default|-toolchain|-browser-image|-browser)?$'
declare -A seen=()
while read -r name; do
  [[ $name =~ $pattern ]] && seen[${BASH_REMATCH[1]}]=1
done < <(
  docker volume ls -q
  docker network ls --format '{{.Name}}'
  docker images --format '{{.Repository}}'
  docker ps -a --format '{{.Names}}'
  docker ps -a --format '{{.Label "com.docker.compose.project"}}'
)

removed=0
for project in "${!seen[@]}"; do
  [[ -n ${live[$project]:-} ]] && continue
  if [[ -n $(docker ps -q --filter "label=com.docker.compose.project=$project") ]] ||
    docker container inspect -f '{{.State.Running}}' "$project-browser" 2>/dev/null | grep -q true; then
    echo "skip $project: a container is running"
    continue
  fi
  echo "remove $project"
  docker ps -aq --filter "label=com.docker.compose.project=$project" | xargs -r docker rm -f >/dev/null
  docker rm -f "$project-browser" >/dev/null 2>&1 || true
  docker network rm "${project}_default" "$project-browser" >/dev/null 2>&1 || true
  docker volume rm "${project}_node_modules" "${project}_venv" >/dev/null 2>&1 || true
  docker image rm "$project-toolchain" "$project-browser-image" >/dev/null 2>&1 || true
  removed=$((removed + 1))
done
echo "Removed the leftovers of $removed projects with no worktree."
