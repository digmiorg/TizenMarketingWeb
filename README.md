# TizenMarketingWeb

This is a hosted Digmi Marketing webapp for Tizen url starter.

## Table Of Contents

* [Where published builds come from](#where-published-builds-come-from)
* [howto tizen](#howto-tizen)
  * [Howto sssp from usb](#howto-sssp-from-usb)
  * [Howto sssp from web](#howto-sssp-from-web)

## Where published builds come from

`production/` and `production/latest/` are both served to displays over SSSP and
are kept in step with each other. `staging/` is separate and is not built by CI.
Releases are built, signed and published by the **Release widget** workflow, and
rolled out to the fleet by **Promote release**, which copies an already-proven
version rather than rebuilding it — see [BUILD.md](BUILD.md).

Do not hand-edit a descriptor. The naming rules below are necessary but not
sufficient: `<ver>` has to be an **integer** that increases, or a display never
re-downloads, and `<size>`, where stated, has to be the package's exact byte
count. The descriptors already committed here say `<ver>1.0.7</ver>` and omit
`<size>` — that is the format the workflow exists to replace, not an example to
copy.

## howto tizen

sssp\_config <widgetname> much match wgt file name

sssp\_config <widgetname> much match app config.xml name

sssp\_config <widgetname> much match app config.xml  \<tizen:application id={id.widgetname}>

example appName = MyApp

sssp\_config.xml

wgt filename MyApp.wgt

```xml
<widgetname>MyApp</widgetname>
```

app config.xml

```xml
<tizen:application id="{packageId}.MyApp" package="{packageId}" required_version="4.0"/>
<name>MyApp</name>
```

### Howto sssp from usb

* howto usb
  * create a folde ron usb stick named SSSP
    * copy sssp\_config.xml to SSSP folder
    * copy .wgt foldfileer to SSSP folder

### Howto sssp from web

put sspp\_config.xml and .wgt file on same directory
