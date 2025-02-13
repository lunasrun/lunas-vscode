# VSCode Extension for Lunas

This is a Visual Studio Code extension for the Lunas language. It provides syntax highlighting, IntelliSense, hover information, and diagnostics for `.lun` files.

## Features

- **Syntax Highlighting**: Provides syntax highlighting for `.lun` files based on the TextMate grammar defined in `syntaxes/lunas.tmLanguage.json`.
- **IntelliSense**: Offers code completion suggestions for Lunas scripts.
- **Hover Information**: Displays type information and documentation on hover.
- **Diagnostics**: Shows syntax and semantic errors in Lunas scripts.

## Getting Started

### Prerequisites

- [Visual Studio Code](https://code.visualstudio.com/)
- [Node.js](https://nodejs.org/)

### Installation

1. Clone the repository:
    ```sh
    git clone https://github.com/yourusername/lunas-vscode.git
    cd lunas-vscode
    ```

2. Install dependencies:
    ```sh
    npm install
    ```

3. Open the project in Visual Studio Code:
    ```sh
    code .
    ```

4. Package the extension:
    ```sh
    npm run package
    ```

5. Open `.lun` files in Visual Studio Code and enjoy the features!

Sample files are provided in the `test` directory.

### Usage

1. Create a new file with a `.lun` extension.
2. Write your Lunas code in the file.
3. Enjoy syntax highlighting, IntelliSense, hover information, and diagnostics.

## Development

## Contributing

Contributions are welcome! Please open an issue or submit a pull request on GitHub.

## License

This project is licensed under the MIT License. See the LICENSE file for details.
