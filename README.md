# vscode-devspace

Using [Devspace.sh](https://devspace.sh) for development in Kubernetes solves a lot of developer experience problems. It shortens the loop of writing code and running in in a Kubernetes cluster to times devs experience running apps locally on their own machines.

The magic can sometimes break. Either file sync crashes, or the devs forgets to turn it on. Don't ask me how I know that. I just do.

This extension helps by adding sync status to the status bar. Now when someone (by someone I totally mean me) forgets to run `devspace dev` and expects things to JustWork, they can easily it's not really supposed to work!
