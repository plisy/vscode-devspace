import * as vscode from "vscode";

import * as k8s from "@kubernetes/client-node";
import * as streamBuffers from "stream-buffers";
import { parse } from "yaml";
import * as fs from "fs";
import * as util from "util";

const readFile = util.promisify(fs.readFile);

// Yeah, not cool but since the whole thing is in one file, ...
const globals = {
    kubernetesConfig: undefined! as k8s.KubeConfig,
    kubernetesClient: undefined! as k8s.CoreV1Api,
    kubernetesExec: undefined! as k8s.Exec,

    devspaceSyncStatusBar: undefined! as vscode.StatusBarItem,
};

// this method is called when the extension is activated
export function activate(context: vscode.ExtensionContext) {
    globals.kubernetesConfig = new k8s.KubeConfig();
    globals.kubernetesConfig.loadFromDefault();
    globals.kubernetesClient = globals.kubernetesConfig.makeApiClient(k8s.CoreV1Api);
    globals.kubernetesExec = new k8s.Exec(globals.kubernetesConfig);
    globals.devspaceSyncStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    globals.devspaceSyncStatusBar.command = "vscode-devspace.refres-sync-status";

    context.subscriptions.push(
        vscode.commands.registerCommand("vscode-devspace.refres-sync-status", async () => {
            await updateStatusBar();
        })
    );

    context.subscriptions.push(globals.devspaceSyncStatusBar);
}

// this method is called when your extension is deactivated
export function deactivate() {}

async function updateStatusBar() {
    const namespaces = await getLastDevspaceNamespaces();

    let containersToCheck: Array<Container> = [];
    for (const n of namespaces) {
        const cs = await getReplacedContainersInNamespace(n);
        containersToCheck = containersToCheck.concat(cs);
    }

    const checks = containersToCheck.map((c) => checkSyncCmdRunning(c));
    for (const c of checks) {
        const v = await c;

        // We check all possible containers but there's sync only into one of them at a time.
        // (this statement will prove wrong at the worst possible moment, I guarantee it)
        if (v.syncRunning) {
            globals.devspaceSyncStatusBar.text = `Devspace: Sync to ${v.podName}`;
            globals.devspaceSyncStatusBar.show();
            return;
        }
    }

    // TODO: Add pretty icons.
    globals.devspaceSyncStatusBar.text = "Devspace: No Sync";
    globals.devspaceSyncStatusBar.show();
}

// `devspace` CLI stores some of it's past and current state in .devspace/generated.yaml file.
// It's an internal implementation detail, but we can use it to check if sync is running.
// There is no public API we could use instead.
async function getLastDevspaceNamespaces(): Promise<Set<string>> {
    let generatedContents: Buffer;
    try {
        // This file is guaranteed to exist, at least initially because the extension is activated
        // when it is found in the workspace.
        generatedContents = await readFile(".devspace/generated.yaml");
    } catch {
        throw new Error("Could not get .devspace/generated.yaml contents.");
    }

    // # ...
    // profiles:
    //   "":
    // 	   #...
    // 	   lastContext:
    // 	     namespace: web
    // 	     context: kind-kind
    const devspaceMetadata = parse(generatedContents.toString());

    const namespaces = new Set<string>();
    for (const profile in devspaceMetadata.profiles) {
        if (devspaceMetadata.profiles[profile]?.lastContext?.namespace) {
            namespaces.add(devspaceMetadata.profiles[profile].lastContext.namespace);
        }
    }

    return namespaces;
}

type Container = {
    namespace: string;
    podName: string;
    containerName: string;
};

async function getReplacedContainersInNamespace(namespace: string): Promise<Array<Container>> {
    const podList = await globals.kubernetesClient
        .listNamespacedPod(
            namespace,
            undefined, // pretty
            undefined, // allowWatchBookmarks
            undefined, // _continue
            undefined, // fieldSelector
            "devspace.sh/replaced=true" // labelSelector
        )
        .then((res) => res.body);

    let containersToCheck: Array<Container> = [];
    for (const pod of podList.items) {
        if (!pod.metadata || !pod.metadata.name || !pod.spec) {
            continue;
        }

        if (!pod.status || pod.status.phase !== "Running") {
            continue;
        }

        for (const container of pod.spec.containers) {
            containersToCheck.push({
                namespace,
                podName: pod.metadata.name,
                containerName: container.name,
            });
        }
    }

    return containersToCheck;
}

// There's no public API to check if sync is running, so we have to be a bit inventive.
// `devspace` uses a helper inside the dev container to do things like pod restarts, sync, and so on.
// When the sync is running, so must the helper run in that container (cause that's where the magic is implemented)
// Conveniently, the helper has a `sync` command. So we list running processes, check whether there is
// `/tmp/devspacehelper sync` running and if so, we know that the sync is on.
function checkSyncCmdRunning(container: Container): Promise<{ syncRunning: boolean; command?: string } & Container> {
    const { namespace, podName, containerName } = container;
    const b = new streamBuffers.WritableStreamBuffer();
    return new Promise((resolve) => {
        globals.kubernetesExec.exec(
            namespace,
            podName,
            containerName,
            ["ps", "-x", "-o", "command"],
            b, // stdout
            null, // stderr
            null, // stdin
            false, // tty
            (res) => {
                console.log("Checking", JSON.stringify(container));
                if (res.status !== "Success") {
                    // for the purpose of the check, this is as good as sync not running
                    console.log("Status code", JSON.stringify(res));
                    return resolve({ ...container, syncRunning: false });
                }

                const runningBins = b.getContentsAsString();
                if (!runningBins) {
                    // for the purpose of the check, this is as good as sync not running
                    console.log("No running bins found");
                    return resolve({ ...container, syncRunning: false });
                }

                const bins = runningBins.split("\n");
                for (const bin of bins) {
                    if (bin.startsWith("/tmp/devspacehelper sync")) {
                        return resolve({ ...container, syncRunning: true, command: bin });
                    }
                }

                return resolve({ ...container, syncRunning: false });
            }
        );
    });
}
