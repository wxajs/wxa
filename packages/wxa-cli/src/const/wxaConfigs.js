import path from 'path';

export const WXA_PROJECT_NAME = 'default';

export default class DefaultWxaConfigs {
    constructor(cwd) {
        this.cwd = cwd;
    }

    get() {
        let context = path.resolve(this.cwd, 'src');
        return {
            target: 'wxa',
            dependencyManager: 'npm',
            context,
            resolve: {
                wxaExt: '.wxa',
                extensions: ['.js', '.json'],
                appScriptPath: path.join(context, 'app.js'),
                appConfigPath: path.join(context, 'app.json'),
                alias: {
                    '@': path.join(this.cwd, 'src'),
                },
            },
            entry: [path.resolve(this.cwd, 'src/app*'), path.resolve(this.cwd, 'src/project.config.json'), path.resolve(this.cwd, 'src/ext.json')],
            output: {
                path: path.resolve(this.cwd, 'dist'),
            },
            use: [
                {
                    test: /\.js$/,
                    name: 'babel',
                },
                {
                    test: /\.sass|\.scss/,
                    name: 'sass',
                },
            ],
            optimization: {
                splitDeps: {
                    enable: false,
                },
                allowEmptyAttributes: true,
                transformPxToRpx: false,
            },
        };
    }
}
