import { debugDedup, MinimalDedupEvent } from "./utils";

async function main(){

    const newEvent: MinimalDedupEvent = {
        'title': "SIPB's 50th anniversary",
        'location': 'SIPB Office',
        'dateTime': new Date('2019-01-01T00:00:00'),
        'fromEmail': {receivedAt: new Date('2018-12-31T00:00:00')}
    };
    
    const otherEvents: MinimalDedupEvent[] = [
        {
        'title': "SIPB's 50th",
        'location': 'SIPB',
        'dateTime': new Date('2019-01-01T00:00:00'),
        'fromEmail': {receivedAt: new Date('2018-12-30T00:00:00')}
        },
        {
        'title': "A celebration of SIPB's 50 years",
        'location': 'SIPB',
        'dateTime': new Date('2019-01-01T00:00:00'),
        'fromEmail': {receivedAt: new Date('2018-12-30T00:00:00')}
        },
        {
        'title': "EC Pizza!",
        'location': 'EC',
        'dateTime': new Date('2019-01-01T00:00:00'),
        'fromEmail': {receivedAt: new Date('2018-12-30T00:00:00')}
        },
        {
        'title': "Maseeh Pizza!",
        'location': 'Maseeh',
        'dateTime': new Date('2019-02-03T00:00:00'),
        'fromEmail': {receivedAt: new Date('2018-12-30T00:00:00')}
        },
        {
        'title': "50 years of SIPB dinner!",
        'location': 'SIPB',
        'dateTime': new Date('2019-01-01T07:00:00'),
        'fromEmail': {receivedAt: new Date('2018-12-30T00:00:00')}
        },
    ]

    await debugDedup(newEvent, otherEvents);
}

await main();