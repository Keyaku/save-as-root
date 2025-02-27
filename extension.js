const vscode = require("vscode")
const { execFile } = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")
const iconv = require("iconv-lite")

// Simplest indicator that this is running in a Flatpak sandbox. If a VScode detects these on a non-sandbox system, that's on the user.
const isFlatpak = !!(process.env.FLATPAK_SANDBOX_DIR || process.env.FLATPAK_ID);

/** @returns {Promise<void>} */
const sudoWriteFile = async (/** @type {string} */filename, /** @type {string | Buffer} */content, /** @type {string} the `sudo --user=user` option  */user) => {
	// Check if file is in sandbox, and update its path accordingly
	filename = await adjustPathForSandbox(filename)

    const config = vscode.workspace.getConfiguration("save-as-root")
    return new Promise((resolve, reject) => {
		// 1. Check if running under Flatpak and filename non-empty, swapping to the appropriate commands accordingly.
        // 2. Authenticate with `sudo -S -p 'password:' sh`.
        // 3. Call `echo file contents:` to inform the parent process that the authentication was successful.
        // 4. Write the file contents with `cat <&0 > "$filename"`.
		let sudoCmd = config.get("command", "sudo")
		let sudoArgs = [...(user === "root" ? [] : ["-u", user]), "-S", "-p", "password:", `filename=${filename}`, "sh", "-c", 'echo "file contents:" >&2; cat <&0 > "$filename"']

		// Check if running under Flatpak
		if (isFlatpak) {
			if (isEmpty(filename)) {
				reject(new Error("File is located in sandbox and cannot be modified."))
			}

			sudoCmd = "flatpak-spawn"
			sudoArgs = ["--host", "sudo", ...sudoArgs]
		}

        const p = execFile(/* "sudo", "/usr/bin/sudo" or "flatpak-spawn" */sudoCmd, sudoArgs)
        p.on("error", (err) => {
            stopTimer()
            reject(err)
        })
        const cancel = (/** @type {Error} */err) => {
            if (!p.killed) { p.kill() }
            stopTimer()
            reject(err)
        }

        // Set a timeout as the script may wait forever for stdin on error.
        /** @type {NodeJS.Timeout | null} */
        let timer = null
        const startTimer = () => {
            timer = setTimeout(() => {
                if (p.exitCode === null) {
                    cancel(new Error(`Timeout: ${stderr}`))
                }
            }, 60 * 1000)  // #17
        }
        const stopTimer = () => {
            if (timer !== null) { clearTimeout(timer) }
            timer = null
        }
        startTimer()

        // Handle stderr.
        let stderr = ""
        p.stderr?.on("data", (/** @type {Buffer} */chunk) => {
            const lines = chunk.toString().split("\n").map((line) => line.trim())
            if (lines.includes("password:")) {
                // Show a password prompt.
                stopTimer()
                vscode.window.showInputBox({ password: true, title: "Save as Root", placeHolder: `password for ${os.userInfo().username}`, prompt: stderr !== "" ? `\n${stderr}` : "", ignoreFocusOut: true }).then((password) => {
                    if (password === undefined) { return cancel(new vscode.CancellationError()) }
                    startTimer()
                    p.stdin?.write(`${password}\n`)
                }, cancel)
                stderr = ""
            } else if (lines.includes("file contents:")) {
                // Write to the file when the authentication is succeeded.
                p.stdin?.write(content)
                p.stdin?.end()
                stderr += lines.slice(lines.lastIndexOf("file contents:") + 1).join("\n")
            } else {
                // Concatenate error messages.
                stderr += chunk.toString()
            }
        })

        // Handle the exit event.
        p.on("exit", (code) => {
            stopTimer()
            if (code === 0) {
                return resolve()
            } else {
                reject(new Error(`exit code ${code}: ${stderr}`))
            }
        })
    })
}

/** @typedef {"utf8" | "utf8bom" | "utf16le" | "utf16be" | "windows1252" | "iso88591" | "iso88593" | "iso885915" | "macroman" | "cp437" | "windows1256" | "iso88596" | "windows1257" | "iso88594" | "iso885914" | "windows1250" | "iso88592" | "cp852" | "windows1251" | "cp866" | "iso88595" | "koi8r" | "koi8u" | "iso885913" | "windows1253" | "iso88597" | "windows1255" | "iso88598" | "iso885910" | "iso885916" | "windows1254" | "iso88599" | "windows1258" | "gbk" | "gb18030" | "cp950" | "big5hkscs" | "shiftjis" | "eucjp" | "euckr" | "windows874" | "iso885911" | "koi8ru" | "koi8t" | "gb2312" | "cp865" | "cp850"} VSCodeFileEncodingName */

/** @returns {string | Buffer} */
const encodeTextWithVSCodeEncodingName = (/** @type {string} */content, /** @type {VSCodeFileEncodingName} */vscodeFileEncodingName) => {
    if (vscodeFileEncodingName === "utf8") {
        return content
    } else if (vscodeFileEncodingName === "utf8bom") {
        return iconv.encode(content, "utf8", { addBOM: true })  // iconv does not accept "utf8bom" as an encoding
    } else {
        if (!iconv.encodingExists(vscodeFileEncodingName)) {
            throw new Error(`Invalid file encoding: ${JSON.stringify(vscodeFileEncodingName)}`)
        }

        return iconv.encode(content, vscodeFileEncodingName, { addBOM: vscodeFileEncodingName === "utf16be" || vscodeFileEncodingName === "utf16le" })
    }
}

/** @returns {boolean} */
const isEmpty = (/** @type {string} */value) => {
	return (value == null || (typeof value === "string" && value.trim().length === 0))
}

/** @returns {Promise<string>} */
const adjustPathForSandbox = async (/** @type {string} */filePath) => {
	// Do nothing if not in Flatpak sandbox
	if (!isFlatpak) {
		return filePath
	}

	let isReserved = false
	let isInHost = false

	// List of reserved paths
	const sandboxPrefixes = [
		"/app", "/bin", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/proc", "/run/flatpak", "/run/host", "/sbin", "/usr"
	];

	// Partial indication that file is in a sandbox
	isReserved = sandboxPrefixes.some(pfx => filePath.startsWith(pfx))

	// If reserved, check if file exists under /run/host
	if (isReserved) {
		// Append only if path does not start with /run/host
		const hostFilePath = filePath.startsWith("/run/host") ? filePath : path.join("/run/host", filePath)
		// If it exists, then update the filePath since it's there we'll be saving our file
		if (fs.existsSync(hostFilePath)) {
			filePath = filePath.replace("/run/host", "")
			isInHost = true
		}
	}

    // Result: if it's under a reserved path AND it doesn't exist in host, then the file is located in the sandbox; using such a path is unintended behavior.
	if (isReserved && !isInHost) {
        filePath = ""
    }
    return filePath;
}

exports.activate = (/** @type {vscode.ExtensionContext} */context) => {
    // Register the "Save as Root" command.
    context.subscriptions.push(vscode.commands.registerCommand("save-as-root.saveFile", async (/** @type {string | undefined} */user = "root") => {
        // Check the status of the editor.
        const editor = vscode.window.activeTextEditor
        if (editor === undefined) {
            return
        }
        if (!["file", "untitled"].includes(editor.document.uri.scheme)) {
            await vscode.window.showErrorMessage(`scheme ${editor.document.uri.scheme} is not supported.`)
            return
        }

        const encoding = /** @type {VSCodeFileEncodingName} */(vscode.workspace.getConfiguration("save-as-root", editor.document).get("files.encoding", "utf8"))

        try {
            if (!editor.document.isUntitled) {
                // Write the editor content to the file.
                await sudoWriteFile(editor.document.fileName, encodeTextWithVSCodeEncodingName(editor.document.getText(), encoding), user)

                // Refocus the `editor` in case the user has switched to a different editor during save, to ensure the next command reverts the correct editor.
                if (vscode.window.activeTextEditor !== editor) {
                    await vscode.window.showTextDocument(editor.document, editor.viewColumn)
                }

                // Reload the file contents from the file system.
                await vscode.commands.executeCommand("workbench.action.files.revert")
            } else if (editor.document.uri.fsPath.startsWith("/")) {  // Untitled files opened with the "code" command (e.g. `code nonexistent.txt`)
                // Write the editor content to the file.
                await sudoWriteFile(editor.document.fileName, encodeTextWithVSCodeEncodingName(editor.document.getText(), encoding), user)

                // Save the viewColumn property before closing the editor.
                const column = editor.viewColumn

                // Refocus the `editor` in case the user has switched to a different editor during save, to ensure the next command reverts and closes the correct editor.
                if (vscode.window.activeTextEditor !== editor) {
                    await vscode.window.showTextDocument(editor.document, editor.viewColumn)
                }

                // Close the editor for the untitled file.
                await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor")

                // Open the newly created file.
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(editor.document.uri.fsPath), column)
            } else { // Untitled files with a numbered name such as "Untitled-1"
                // Show the save dialog.
                const input = await vscode.window.showSaveDialog({})
                if (input === undefined) {
                    return
                }
                const filename = input.fsPath

                // Create a file and write the editor content to it.
                await sudoWriteFile(filename, encodeTextWithVSCodeEncodingName(editor.document.getText(), encoding), user)

                // Save the viewColumn property before closing the editor.
                const column = editor.viewColumn

                // Refocus the `editor` in case the user has switched to a different editor during save, to ensure the next command reverts and closes the correct editor.
                if (vscode.window.activeTextEditor !== editor) {
                    await vscode.window.showTextDocument(editor.document, editor.viewColumn)
                }

                // Close the editor for the untitled file.
                await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor")

                // Open the newly created file.
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(filename), column)
            }
        } catch (err) {
            // Handle errors.
            if (err instanceof vscode.CancellationError) {
                return
            }
            console.error(err)
            if (err instanceof Error && "code" in err && err.code === "ENOENT" && "path" in err && err.path === "sudo") {  // #15
                await vscode.window.showErrorMessage(`[Save as Root] The extension could not find the sudo command. Install the sudo package using the system's package manager (e.g. apt-get install sudo).`)
                return
            } else if (err instanceof Error && err.message.includes("NixOS's wrapper.c failed.")) {  // #19
                await vscode.window.showErrorMessage(`[Save as Root] NixOS's security wrapper prevented the sudo command from running. Try setting the configuration "save-as-root.command" to "/usr/bin/sudo". \nOriginal error:\n${/** @type {Error} */(err).message}`)
                return
            } else if (err instanceof Error && "path" in err && err.path === "flatpak-spawn") {
				await vscode.window.showErrorMessage(`[Save as Root] flatpak-spawn did not work properly. If this extension is not running in a Flatpak sandbox, make sure the environment variables FLATPAK_SANDBOX_DIR and FLATPAK_SANDBOX_DIR are not set. \nOriginal error:\n${/** @type {Error} */(err).message}`)
				return
			}
            await vscode.window.showErrorMessage(`[Save as Root] ${/** @type {Error} */(err).message}`)
        }
    }))

    // Register the "Save as Specified User…" command.
    {
        // Persist the username input in the input box for the "Save as Specified User…" command until the VSCode's window is closed.
        let value = ""

        context.subscriptions.push(vscode.commands.registerCommand("save-as-root.saveFileAsSpecifiedUser", async () => {
            // Show an input box to select a user
            const user = value = await vscode.window.showInputBox({ value, placeHolder: "username", ignoreFocusOut: true }) || ""
            if (!user) {
                await vscode.window.showInformationMessage("Canceled.")
                return
            }

            // Redirect to the main command
            vscode.commands.executeCommand("save-as-root.saveFile", user)
        }))
    }

    // Register the "New File as Root..." command.
    context.subscriptions.push(vscode.commands.registerCommand("save-as-root.newFile", async (/** @type {vscode.Uri | undefined} */uri) => {
        try {
            /** @type {VSCodeFileEncodingName} */
            let encoding = "utf8"

            // `uri` is set when the command is invoked from the explorer's context menu.
            // Otherwise, we fall back to the workspace folder or the user's home directory.
            if (uri === undefined && vscode.window.activeTextEditor !== undefined) {
                uri = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)?.uri
                encoding = vscode.workspace.getConfiguration("save-as-root", vscode.window.activeTextEditor.document).get("files.encoding", "utf8")
            }
            if (uri === undefined && vscode.workspace.workspaceFolders !== undefined && vscode.workspace.workspaceFolders.length > 0) {
                uri = vscode.workspace.workspaceFolders[0].uri
            }
            if (uri === undefined) {
                uri = vscode.Uri.parse(os.homedir())
            }

            if (uri.scheme !== "file") {
                await vscode.window.showErrorMessage(`Unsupported uri scheme: ${uri.scheme}`)
                return
            }
            const value = uri.fsPath + path.sep
            const filepath = await vscode.window.showInputBox({ value, valueSelection: [value.length, value.length] })
            if (!filepath || filepath.endsWith(path.sep)) {
                return
            }
            await sudoWriteFile(filepath, encodeTextWithVSCodeEncodingName("", encoding), "root")
            await vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(filepath))
        } catch (err) {
            await vscode.window.showErrorMessage(`[Save as Root] ${/** @type {Error} */(err).message}`)
        }
    }))
}

exports.deactivate = () => { }
