---
title: 命令
type: api
---

## Create

运行以下命令创建一个新项目

``` bash
wxa2 create [options]
```

- **options**:
  - `repo`: 指定数据源用于拉取数据，允许自定义仓库路径。可选 `github`, `gitee`，网络原因考虑默认`gitee`

然后按提示在命令行中依次：

1. 输入项目名
2. 选择需要的[模板](https://github.com/wxajs/wxa-templates)

一个新的wxa项目就创建好了。创建项目，需要在微信开发者工具中调试开发，按照下述步骤进行：

1. 打开新建的项目
2. 运行`npm i`安装依赖
3. 依赖安装完毕后，运行`wxa2 build -w`
4. 打开微信开发者工具添加小程序项目，指定文件夹到`path/to/project/dist`

即可开始小程序项目开发。

::: tip 提示
目前`create`命令本质是从github clone代码到本地，如遇到创建失败，可以手动从[模板库](https://github.com/wxajs/wxa-templates)下载模板。
:::

::: tip 附录
目前支持的模板有：
- **Base**: 基础模板，最简洁的wxa项目模板。
- **Redux**: 引入`@wxa/redux`，需要在项目中使用redux的开发者可以选择这个。
- **Vant**: 适配`vant-weapp`（有赞UI）组件，项目中可以直接在`usingComponents`引用对应有赞组件。
- **Echarts**: 适配`Echarts for mini-program`
- **Cloud**: 云开发模板

具体代码请查看[模板库](https://github.com/wxajs/wxa-templates)
:::



## Build

``` sh
  用法: wxa2 build [options]

  编译项目

  选项:
    --configs-path <configsPath> wxa.configs.js文件路径，默认项目根目录
    -w, --watch              监听文件改动
    -N, --no-cache           不使用缓存
    --source-map             生成sourceMap并输出
    -p, --project <project>  指定需要编译的项目，默认是default， * 表示编译所有项目
    --no-progress            不展示文件进度
    --verbose                展示多余的信息
    -t, --target             编译目标平台，如微信小程序wechat, 头条小程序tt
    --mock                   是否编译wxa:mock指令
    -h, --help               output usage information
```

### 标准构建

标准构建下，wxa会对`entry`（默认是`src/app.*`）进行依赖分析，并形成一颗依赖树，再经过代码优化步骤后，输出到指定文件夹下。

运行下面命令开始标准构建：

```bash
wxa2 build
# wxa2 build --watch 开启监听模式
```

如果需要区分环境的话，可以通过`cross-env`实现：

``` bash
# 生产构建
cross-env NODE_ENV=production wxa2 build --no-cache
# 开发
cross-env NODE_ENV=development wxa2 build --watch
```

::: tip 提示
只要符合默认的项目结构，一个小程序项目可以不需要任何配置即可进行标准构建，即**零配置构建**
:::

### 监听模式

开发过程中，对于文件修改、增删等操作，自动进行重新编译是很实用的功能。`wxa`使用`chokidar`对于依赖树上的节点进行监听，自动重新编译代码并更新依赖树。

```bash
wxa2 build --watch
# 或
wxa2 build -w
```

### 批量模式
批量模式，在三方开发中非常常用，只需要在`wxa.config.js`导出一个数组即可，批量的打包小程序。指定多个三方小程序的需要替换的入口文件，wxa配置，插件，以及输出目录等。详细使用教程参考[三方开发](../learn/advance/third-party-wxa)


``` js
// wxa.config.js

module.exports = [
    // 每配置一个对象意味着多输出一个三方小程序
    {
        // 输出dist-A文件夹下
        output: {
            path: path.resolve(__dirname, 'dist-A'),
        },
        // 环境变量替换
        plugins: [
            new ReplacePlugin({
                list: {
                    'WXA_ENV': 'HEY A',
                },
            }),
        ],
        // 需要替换的文件，理论上所有entry文件都可以被替换。
        point: {
            'ext.json': path.resolve(__dirname, 'projects/A/ext.json'),
            'app.wxa': path.resolve(__dirname, 'projects/A/app.wxa'),
        },
        // 别名，用于区分不同三方小程序
        name: 'PartnerA',
    },
    {
        output: {
            path: path.resolve(__dirname, 'B'),
        },
        plugins: [
            new ReplacePlugin({
                list: {
                    'WXA_ENV': 'HEY B',
                },
            }),
        ],
        point: {
            'ext.json': path.resolve(__dirname, 'projects/B/ext.json'),
            'app.wxa': path.resolve(__dirname, 'projects/B/app.wxa'),
        },
        name: 'PartnerB',
    },
];
```

配置完毕后，运行以下命令即可输出多个三方小程序。

``` bash
# 一次性构建多个三方小程序
wxa2 build --project *
# 或者
wxa2 build -p *
```

开发过程中，可以搭配监听模式和三方模式一起使用。

``` bash
# 监听项目，同时持续更新PartnerA和PartnerB代码文件。
wxa2 build -w -p PartnerA,PartnerB
# 完整的命令为:
wxa2 build --watch --project=PartnerA,PartnerB
```

## Cli
命令行调用微信开发者工具

``` sh
  用法: wxa2 build [options]

  编译项目

  选项:
    --configs-path <configsPath> wxa.configs.js文件路径，默认项目根目录
    -a, --action <action>    指定操作, open, login, preview, upload
    -p, --project <project>  指定需要编译的项目，默认是default， * 表示编译所有项目
    -h, --help               output usage information
```

### 项目配置文件
开发者工具在解析、编译项目依赖于[`project.config.json`](https://developers.weixin.qq.com/miniprogram/dev/devtools/projectconfig.html)，默认情况下，一个小程序项目不需要开发者手动修改该文件，在开发者工具界面设置完毕后会自动生成一份最新的配置文件。

:pushpin: 所有通过cli调用微信开发者工具的操作都依赖该配置文件，且配置格式不能错误，否则调用将直接失败。

### 登录
在命令行中打印登录二维码。后续预览、上传操作需要提前登录。

``` bash
wxa2 cli -a login
```

### 预览
上传代码到开发版，并在命令行中打印预览二维码。

``` bash
wxa2 cli -a preview
```

### 上传代码
上传代码到`mp`后台，:warning:小程序测试号无法上传代码。

``` bash
# 上传默认项目
wxa2 cli -a upload
# 一次性上传多个三方项目
wxa2 cli -a upload -p *
```

::: tip ext.json
三方开发的时候，在`ext.json`中配置`directCommit: true`，可以直接上传代码到体验版
:::

::: warning 警告
一次性上传多个三方项目的时候，要求每个三方项目都有一个项目配置文件，即`project.config.json`。
:::

### 原生小程序编译成 WXA
将原生小程序编译成 `wxa` 文件。

```
wxa convert -i <input dir> -o <output dir>
```
将 `<input dir>` 目录下的原生小程序代码编译成 `wxa` 文件到 `<output dir>` 目录。

只会将 `.wxss`, `.json`, `.js`, `.wxml` 合并到一个 `.wxa` 文件中，而不会进行语法的转换。